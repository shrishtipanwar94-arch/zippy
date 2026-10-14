// THE SOLVER — the four engine pieces assembled into one decision.
//
//   snapshot -> candidates (Phase 6) -> feasibility (Phase 7)
//            -> cost (Phase 8) -> global assignment (Phase 9)
//
// INVARIANT 2: THIS FILE WRITES NOTHING. It is a pure function over a
// snapshot: the same snapshot and the same `now` produce the same plans,
// every time, which is exactly what makes the Phase 10 evaluation harness
// able to compare two policies and attribute the difference to the policy.
// It does not read the database either — a caller assembles the snapshot and
// hands it in. Persisting the result is a separate step in
// src/commit/persistSolverRun.ts, because recording a decision is a mutation
// and mutations live in /src/commit.
//
// That separation is not a stylistic preference; it is checked. The standing
// grep over src/engine/*.ts for the Prisma client's package name has to stay
// empty, and it could not if this file talked to a database.
//
// SEVERAL PLANS, NOT ONE. The same feasible options are ranked once per named
// weight vector, producing the competing plans a dispatcher chooses between.
// Running the assignment a few more times is cheap next to generating the
// candidates once, and offering a choice is the difference between a tool an
// operator trusts and one they fight. Phase 20 added a fourth,
// PROTECT_CONTRACTS, and the count is deliberately not written down anywhere
// but WEIGHT_VECTORS — adding a vector should be one edit.

import { createHash } from 'node:crypto';
import { generateCandidates } from './candidates.js';
import type {
  DispatchOption,
  DispatchSnapshot,
  JobForDispatch,
  SafetyLevelSnapshot,
} from './candidates.js';
import { checkFeasibility } from './feasibility.js';
import type { Rejection } from './feasibility.js';
import { scoreOption } from './cost.js';
import type { CostBreakdown, WeightVectorName } from './cost.js';
import { WEIGHT_VECTORS } from './cost.js';
import { UNAVAILABLE_COST, solveAssignment } from './allocation.js';
import { addBand, countRejectionsByCode, countUnassignedByReason } from './trace.js';
import type { SafetyBandTrace, StageReporter } from './trace.js';
import { findContestedResources } from '../domain/contractContention.js';
import type { ContestedResource } from '../domain/contractContention.js';
import type { TravelTimeSource } from '../infra/routing.js';

export type ScoredCandidate = {
  jobId: string;
  option: DispatchOption;
  cost: CostBreakdown;
};

export type PlanAssignment = {
  jobId: string;
  unitId: string;
  technicianId: string;
  cost: CostBreakdown;
  // The option this assignment was chosen from. Carried so a caller does not
  // have to regenerate candidates to recover the travel time and resolvable
  // faults behind the decision — regenerating would be a second answer to a
  // question this run already answered, and the two could disagree.
  option: DispatchOption;
};

export type Plan = {
  label: WeightVectorName;
  assignments: PlanAssignment[];
  // Jobs that got no unit in this plan. A first-class part of the answer, not
  // an omission — a dispatcher needs to see who is still waiting.
  unassignedJobIds: string[];
  totalCost: number;
};

export type SolverOutcome = {
  snapshotHash: string;
  plans: Plan[];
  rejected: (Rejection & { jobId: string })[];
  optionCount: number;
  feasibleCount: number;
  zonePartitioned: boolean;
  wallClockMs: number;
  // PHASE 17. True when the deadline cut the run short. What comes back is
  // then the best plan FOUND, not the best plan there is, and `unplannedJobIds`
  // names the jobs the planner never looked at.
  timedOut: boolean;
  unplannedJobIds: string[];
  // PHASE 20. Scarce units the recommended plan gave to a contract job over a
  // consumer job (or the reverse) at the SAME safety level, each priced both
  // ways. Empty on almost every run. The solver does not resolve these — it
  // names them, and src/commit/contention.ts turns each one into an APPROVE
  // ActionRequest for a human to settle.
  contestedResources: ContestedResource[];
};

// ---------------------------------------------------------------------------
// A fingerprint of exactly what the solver was looking at. Two runs with the
// same hash saw the same world, which is what makes a stored SolverRun
// replayable and a disagreement between two runs attributable.
//
// Only the fields that can change a decision go in — a unit's `updatedAt`
// moving would otherwise make every snapshot look different while changing
// nothing. Everything is sorted first, because Postgres makes no promise
// about row order and an unsorted hash would differ run to run for identical
// state.
export function hashSnapshot(jobs: JobForDispatch[], snapshot: DispatchSnapshot): string {
  const canonical = {
    jobs: [...jobs]
      .map((job) => ({
        id: job.id,
        lat: job.lat,
        lng: job.lng,
        faults: job.faultDistribution,
        safety: job.safetyLevel,
        sla: job.slaResponseMinutes,
        // The pinned contract terms are a real input to a decision from Phase
        // 20 — the penalty is a cost term — so two runs that priced the same
        // job under different terms must not carry the same hash.
        contract: job.contract,
        createdAt: job.createdAt.toISOString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    units: [...snapshot.units]
      .map((unit) => ({
        id: unit.id,
        zone: unit.zoneId,
        tech: unit.currentTechnicianId,
        status: unit.status,
        kind: unit.kind,
        caps: [...unit.capabilityCodes].sort(),
        lat: unit.lat,
        lng: unit.lng,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    technicians: [...snapshot.technicians]
      .map((technician) => ({ id: technician.id, caps: [...technician.capabilityCodes].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    shifts: [...snapshot.shifts]
      .map((shift) => ({
        tech: shift.technicianId,
        from: shift.startsAt.toISOString(),
        to: shift.endsAt.toISOString(),
      }))
      .sort((a, b) => a.tech.localeCompare(b.tech) || a.from.localeCompare(b.from)),
    // Zone centroids are in here because they are a real input to a decision,
    // not just a label: a unit with no last-known position is located at its
    // zone's centroid (candidates.ts `unitLocation`), so moving a centroid
    // moves that unit and can change which plan wins. Leaving them out would
    // let two runs that produced different plans carry the same hash.
    zones: [...snapshot.zones]
      .map((zone) => ({ id: zone.id, lat: zone.centroidLat, lng: zone.centroidLng }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ---------------------------------------------------------------------------
// Build one plan by solving the assignment problem over a set of jobs.
//
// THE MATRIX IS JOBS x UNITS, not jobs x options. An option is a
// (job, unit, technician) triple, so "the same option for two jobs" is not a
// thing — but a UNIT genuinely can only go to one job (invariant 7), and that
// is the constraint the assignment problem exists to respect. Each cell holds
// the cost of that job's best option using that unit, or UNAVAILABLE_COST
// when the job has no feasible option with it.
//
// SAFETY BANDS — INVARIANT 4, IN THE GLOBAL ASSIGNMENT (Phase 20).
//
// ranking.ts puts safety above cost when choosing WHO to send to one job. That
// is not the same guarantee as putting it above cost when choosing WHICH JOB
// gets the last van, and until this phase the second guarantee did not exist:
// one Hungarian run over a matrix of cost totals minimises the SUM, so a plan
// could hand the only feasible unit to two ordinary jobs because that summed
// cheaper than serving the one job with a person standing on a live
// carriageway. Contract SLA entering the objective made that reachable in
// practice — a GOLD penalty is a large number, and a large enough number wins
// an argument the cost function was never supposed to be having.
//
// So the assignment is solved once per safety level, most dangerous first, and
// each band only sees the units the bands above it did not take. No amount of
// cost — contract penalty included — can move a unit from a HIGH_RISK job to
// an ELEVATED or NORMAL one, because by the time the NORMAL band is solved the
// unit is already gone. Cost still ranks everything; it ranks second.
//
// WHAT THIS COSTS: the plan is no longer globally cost-optimal, and it is not
// meant to be. Solving bands in sequence is greedy ACROSS the bands and exact
// WITHIN each of them, so a HIGH_RISK job can take a unit an ELEVATED job
// needed more, at a higher total. That is the trade invariant 4 asks for,
// stated plainly, and it only bites when two safety levels genuinely compete: a
// board where every job is NORMAL produces exactly the plan it produced before.
const SAFETY_ASSIGNMENT_ORDER: SafetyLevelSnapshot[] = ['HIGH_RISK', 'ELEVATED', 'NORMAL'];

function buildPlan(
  label: WeightVectorName,
  jobIds: string[],
  unitIds: string[],
  scored: ScoredCandidate[],
  safetyByJob: Map<string, SafetyLevelSnapshot>,
  // Told about each band as it is solved, so a caller can watch the handover
  // rather than infer it from the finished plan. Optional, and absent for every
  // vector but the recommended one — see the call site.
  onBand?: (band: SafetyBandTrace) => void,
): Plan {
  const bestByJobAndUnit = new Map<string, ScoredCandidate>();
  for (const candidate of scored) {
    const key = `${candidate.jobId} ${candidate.option.unitId}`;
    const existing = bestByJobAndUnit.get(key);
    // A job could in principle have more than one option on the same unit if
    // a unit ever carried more than one technician. Keep the cheaper.
    if (!existing || candidate.cost.total < existing.cost.total) {
      bestByJobAndUnit.set(key, candidate);
    }
  }

  const assignments: PlanAssignment[] = [];
  const unassignedJobIds: string[] = [];
  let totalCost = 0;
  let remainingUnitIds = unitIds;

  for (const level of SAFETY_ASSIGNMENT_ORDER) {
    // An unrecognised safety level is treated as NORMAL rather than dropped: a
    // job that fell out of every band would be a stranded customer nobody could
    // see, which is the worst failure this file could produce.
    const bandJobIds = jobIds.filter((jobId) => (safetyByJob.get(jobId) ?? 'NORMAL') === level);
    if (bandJobIds.length === 0) continue;

    const band = assignBand(bandJobIds, remainingUnitIds, bestByJobAndUnit);
    assignments.push(...band.assignments);
    unassignedJobIds.push(...band.unassignedJobIds);
    totalCost += band.totalCost;

    const taken = new Set(band.assignments.map((assignment) => assignment.unitId));
    const leftBelow = remainingUnitIds.filter((unitId) => !taken.has(unitId));

    onBand?.({
      level,
      jobCount: bandJobIds.length,
      assignedCount: band.assignments.length,
      unitsOffered: remainingUnitIds.length,
      unitsLeftBelow: leftBelow.length,
    });

    remainingUnitIds = leftBelow;
  }

  return { label, assignments, unassignedJobIds, totalCost };
}

// One Hungarian run over one safety band. This is what buildPlan used to be,
// unchanged — it simply no longer sees the whole board at once.
function assignBand(
  jobIds: string[],
  unitIds: string[],
  bestByJobAndUnit: Map<string, ScoredCandidate>,
): { assignments: PlanAssignment[]; unassignedJobIds: string[]; totalCost: number } {
  const matrix = jobIds.map((jobId) =>
    unitIds.map((unitId) => bestByJobAndUnit.get(`${jobId} ${unitId}`)?.cost.total ?? UNAVAILABLE_COST),
  );

  const { assignedColumn } = solveAssignment(matrix);

  const assignments: PlanAssignment[] = [];
  const unassignedJobIds: string[] = [];
  let totalCost = 0;

  jobIds.forEach((jobId, row) => {
    const col = assignedColumn[row];
    if (col === null || col === undefined) {
      unassignedJobIds.push(jobId);
      return;
    }

    const candidate = bestByJobAndUnit.get(`${jobId} ${unitIds[col]!}`)!;
    assignments.push({
      jobId,
      unitId: candidate.option.unitId,
      technicianId: candidate.option.technicianId,
      cost: candidate.cost,
      option: candidate.option,
    });
    totalCost += candidate.cost.total;
  });

  return { assignments, unassignedJobIds, totalCost };
}

// ZONE PARTITIONING — a deliberate approximation, above a configurable size.
//
// KNOWN COST OF THIS APPROXIMATION: a job near a zone boundary can lose a
// better cross-zone option, because the unit that would have served it is
// solved in a different matrix and never appears as a candidate in this one.
// The trade is that the Hungarian algorithm is O(n^3) in the number of jobs,
// so one citywide matrix during a busy hour grows faster than the arrival
// rate that caused it. Phase 10's harness measures how often the boundary
// case actually costs anything — until then this is a known approximation
// with an unmeasured price, which is why the threshold is config and not a
// constant.
function partitionByZone(
  jobs: JobForDispatch[],
  snapshot: DispatchSnapshot,
  jobZone: Map<string, string>,
): { jobIds: string[]; unitIds: string[] }[] {
  const zones = new Set<string>([...jobZone.values()]);
  const partitions: { jobIds: string[]; unitIds: string[] }[] = [];

  for (const zone of [...zones].sort()) {
    partitions.push({
      jobIds: jobs.filter((job) => jobZone.get(job.id) === zone).map((job) => job.id),
      unitIds: snapshot.units.filter((unit) => unit.zoneId === zone).map((unit) => unit.id),
    });
  }

  return partitions;
}

// ---------------------------------------------------------------------------
// THE PLAN THE SOLVER PUTS FORWARD. The console marks it "recommended", the
// evaluation harness measures it, and the cross-tenant contention check below
// asks its question of it — one name, so all three cannot drift apart.
export const RECOMMENDED_PLAN: WeightVectorName = 'BALANCED';

// Which scarce units one plan handed to a contract job over a consumer job at
// the same safety level, or the reverse. The rule itself is
// src/domain/contractContention.ts's; this only reshapes the solver's own types
// into the plain ones that function takes.
function contestedIn(
  label: WeightVectorName,
  plans: Plan[],
  scored: ScoredCandidate[],
  jobs: JobForDispatch[],
): ContestedResource[] {
  const plan = plans.find((candidate) => candidate.label === label);
  if (!plan) return [];

  return findContestedResources({
    jobs: jobs.map((job) => ({
      id: job.id,
      // A contract with no penalty clause is not something to escalate over:
      // there is no obligation for a consumer job to be weighed against.
      hasContract: (job.contract?.breachPenaltyPaise ?? 0) > 0,
      safetyLevel: job.safetyLevel,
    })),
    options: scored
      .filter((candidate) => candidate.cost.weightVector === label)
      .map((candidate) => ({
        jobId: candidate.jobId,
        unitId: candidate.option.unitId,
        cost: candidate.cost.total,
      })),
    assignments: plan.assignments.map((assignment) => ({
      jobId: assignment.jobId,
      unitId: assignment.unitId,
    })),
    unassignedJobIds: plan.unassignedJobIds,
  });
}

// ---------------------------------------------------------------------------
export type SolveInput = {
  jobs: JobForDispatch[];
  snapshot: DispatchSnapshot;
  now: Date;
  // Which zone each job belongs to. Passed in rather than derived, because
  // the job row already carries it — recomputing nearest-zone here would be a
  // second answer to a question the database already answered.
  jobZone: Map<string, string>;
  zonePartitionThreshold: number;
  // HOW LONG THE PLANNER MAY TAKE before it must answer with what it has.
  //
  // A deadline is not an error case, it is the shape of the problem: a plan
  // that arrives after the situation changed is worth less than a decent plan
  // that arrives now. When it fires, the jobs already scored are planned
  // normally — that is the "best incumbent" — and the jobs not reached keep
  // whatever assignment they already had, untouched, until the next run.
  //
  // Undefined means no deadline, which is what every caller before Phase 17
  // passed and what the evaluation harness still passes: a measurement whose
  // result depended on how busy the machine was would not be a measurement.
  deadlineMs?: number;
  // Where travel time comes from. Defaults to production OSRM inside
  // generateCandidates; the Phase 10 harness passes `haversineTravelTimes` so
  // a replayed scenario is instant and identical every run.
  travelTimes?: TravelTimeSource;
  // TOLD WHAT IS HAPPENING, AS IT HAPPENS. Optional and read-only: a run with a
  // reporter attached produces exactly the plans a run without one produces, so
  // the evaluation harness passing none loses nothing but the narration. See
  // src/engine/trace.ts for why the stages carry facts and never sentences.
  onStage?: StageReporter;
};

export async function solve(input: SolveInput): Promise<SolverOutcome> {
  const startedAt = Date.now();
  const { jobs, snapshot, now, jobZone, zonePartitionThreshold, travelTimes, deadlineMs } = input;
  const onStage = input.onStage;
  const since = () => Date.now() - startedAt;

  onStage?.({
    stage: 'PENDING',
    elapsedMs: 0,
    jobCount: jobs.length,
    unitCount: snapshot.units.length,
    availableUnitCount: snapshot.units.filter((unit) => unit.status === 'AVAILABLE').length,
    technicianCount: snapshot.technicians.length,
  });

  // 1-3. Candidates then feasibility, per job.
  const scored: ScoredCandidate[] = [];
  const rejected: (Rejection & { jobId: string })[] = [];
  const unplannedJobIds: string[] = [];
  let optionCount = 0;
  let timedOut = false;

  for (const job of jobs) {
    // CHECKED BEFORE THE EXPENSIVE PART, not after. Candidate generation is
    // what costs — it is the routing call — so a deadline that only stopped
    // work after generating the options would save nothing.
    if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
      timedOut = true;
      unplannedJobIds.push(job.id);
      continue;
    }

    const options = await generateCandidates(job, snapshot, travelTimes, now);
    optionCount += options.length;

    const { feasible, rejected: jobRejections } = checkFeasibility(options, job, snapshot, now);
    for (const rejection of jobRejections) rejected.push({ ...rejection, jobId: job.id });

    // 4. Score every feasible option under every weight vector at once —
    // generating candidates is the expensive part and it has already happened.
    for (const option of feasible) {
      for (const label of Object.keys(WEIGHT_VECTORS) as WeightVectorName[]) {
        scored.push({ jobId: job.id, option, cost: scoreOption(option, job, now, label) });
      }
    }
  }

  const feasibleCount = scored.length / Object.keys(WEIGHT_VECTORS).length;
  const zonePartitioned = optionCount > zonePartitionThreshold;

  onStage?.({
    stage: 'CANDIDATES',
    elapsedMs: since(),
    jobCount: jobs.length - unplannedJobIds.length,
    optionCount,
  });
  onStage?.({
    stage: 'FEASIBILITY',
    elapsedMs: since(),
    optionCount,
    feasibleCount,
    rejectedCount: rejected.length,
    rejectedByCode: countRejectionsByCode(rejected),
  });

  // 5. One assignment per weight vector.
  const allJobIds = jobs.map((job) => job.id);
  const allUnitIds = snapshot.units.map((unit) => unit.id);
  const partitions = zonePartitioned
    ? partitionByZone(jobs, snapshot, jobZone)
    : [{ jobIds: allJobIds, unitIds: allUnitIds }];

  const safetyByJob = new Map(jobs.map((job) => [job.id, job.safetyLevel]));

  // THE SAFETY HANDOVER IS REPORTED FOR ONE PLAN ONLY — the recommended one.
  // Every vector solves the same bands in the same order over the same jobs, so
  // reporting all four would put the same argument on screen four times about
  // plans nobody took. Summed across zone partitions; see trace.ts `addBand`.
  const bandTotals = new Map<SafetyLevelSnapshot, SafetyBandTrace>();

  const plans: Plan[] = (Object.keys(WEIGHT_VECTORS) as WeightVectorName[]).map((label) => {
    const forThisVector = scored.filter((candidate) => candidate.cost.weightVector === label);
    const recordBand =
      onStage && label === RECOMMENDED_PLAN
        ? (band: SafetyBandTrace) => addBand(bandTotals, band)
        : undefined;

    // Each partition is solved independently and the results concatenated —
    // a unit only ever appears in one partition, so no unit can be assigned
    // twice across them.
    const parts = partitions.map((partition) =>
      buildPlan(label, partition.jobIds, partition.unitIds, forThisVector, safetyByJob, recordBand),
    );

    if (recordBand) {
      onStage?.({
        stage: 'SAFETY_BANDS',
        elapsedMs: since(),
        planLabel: label,
        bands: SAFETY_ASSIGNMENT_ORDER.flatMap((level) => bandTotals.get(level) ?? []),
      });
    }

    return {
      label,
      assignments: parts.flatMap((part) => part.assignments),
      unassignedJobIds: parts.flatMap((part) => part.unassignedJobIds),
      totalCost: parts.reduce((sum, part) => sum + part.totalCost, 0),
    };
  });

  const recommended = plans.find((plan) => plan.label === RECOMMENDED_PLAN);

  onStage?.({
    stage: 'COST',
    elapsedMs: since(),
    // Read off the weight vector rather than written down, for the same reason
    // the plan count is not written down: adding a term should be one edit.
    termCount: Object.keys(WEIGHT_VECTORS[RECOMMENDED_PLAN]).length,
    planLabels: Object.keys(WEIGHT_VECTORS),
    zonePartitioned,
  });

  if (recommended) {
    onStage?.({
      stage: 'OUTCOME',
      elapsedMs: since(),
      planLabel: recommended.label,
      assignedCount: recommended.assignments.length,
      unassignedCount: recommended.unassignedJobIds.length,
      unassignedByReason: countUnassignedByReason(recommended.unassignedJobIds, rejected),
    });
  }

  // 6. Which scarce units a contract job and a consumer job both wanted.
  //
  // ASKED OF THE RECOMMENDED PLAN ONLY. A dispatcher is escalated the
  // trade-off the system would otherwise have made on their behalf, and the
  // plan it would have made it in is the one it puts forward. Asking the same
  // question of every vector would raise the same argument three more times
  // about plans nobody took.
  const contestedResources = contestedIn(RECOMMENDED_PLAN, plans, scored, jobs);

  // 7. Return the plans. Nothing has been written.
  const wallClockMs = Date.now() - startedAt;

  onStage?.({
    stage: 'DONE',
    elapsedMs: wallClockMs,
    wallClockMs,
    timedOut,
    unplannedCount: unplannedJobIds.length,
  });

  return {
    snapshotHash: hashSnapshot(jobs, snapshot),
    plans,
    rejected,
    optionCount,
    feasibleCount,
    zonePartitioned,
    wallClockMs,
    timedOut,
    unplannedJobIds,
    contestedResources,
  };
}
