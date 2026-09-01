// THE DISCRETE-EVENT SIMULATION LOOP.
//
// A scenario is replayed against one policy and the whole run is recorded.
// Time advances in jumps to the next moment something happens — a job
// arriving, a crew finishing — rather than tick by tick, because nothing
// changes in between and stepping through empty minutes only makes the run
// slower without making it truer.
//
// WHERE TIME-TO-RESOLUTION COMES FROM, which is the whole reason this file
// exists. When a crew arrives, the runner asks whether they can fix the fault
// the vehicle ACTUALLY has (`scenario.trueFault`) — not the one the
// dispatcher believed. If they can, the job resolves and that is a first-visit
// resolution. If they cannot, they spend `diagnoseMinutes` finding that out,
// the unit is released, and the job goes back on the pending list after a
// re-dispatch coordination delay. The second dispatch's travel and repair
// then happen for real, in the simulation, rather than being estimated.
//
// That is the difference between arrival and resolution, and it is why a
// policy can win every arrival-time comparison and still lose.
//
// DETERMINISM. Nothing here reads a clock or `Math.random`. Every random draw
// happened when the scenario was built. The only wall-clock measurement is
// how long the policy itself took to decide, which is recorded separately and
// deliberately kept out of the reproducible output — see metrics.ts.

import type { FaultCode } from '../src/domain/faults.js';
import { partSkusForFault } from '../src/domain/faults.js';
import { diagnoseMinutes, resolveMinutes, REDISPATCH_COORDINATION_MINUTES } from '../src/engine/durations.js';
import type { DispatchSnapshot, UnitSnapshot } from '../src/engine/candidates.js';
import type { Policy, PolicyDecision } from './policies/index.js';
import type { Scenario, ScenarioJob } from './scenarios/index.js';
import { SCENARIO_START } from './scenarios/index.js';

// Above this many candidate options the production solver partitions by zone.
// Defaults to the production value so the harness measures the solver as it
// ships; overridable so the COST of partitioning can itself be measured by
// running one scenario twice with nothing else changed.
const ZONE_PARTITION_THRESHOLD = 400;

export type RunOptions = { zonePartitionThreshold?: number };

export type JobRecord = {
  jobId: string;
  arrivalMinute: number;
  trueFault: FaultCode;
  slaResponseMinutes: number | null;
  dispatchCount: number;
  // Minute the FIRST crew reached the vehicle. Null while never dispatched.
  firstArrivalMinute: number | null;
  resolvedMinute: number | null;
  firstVisitResolved: boolean;
  // Visits that failed because the shelf was empty, NOT because the crew
  // lacked the skill. This is the number Phase 19 exists to move: a policy
  // blind to stock sends crews who are perfectly qualified and then cannot
  // finish, and no skill-based metric can see that happening.
  stockoutFailures: number;
  // The technician who actually finished it, for the earnings distribution.
  resolvedBy: string | null;
};

export type RunResult = {
  scenario: string;
  policy: string;
  jobs: JobRecord[];
  // Busy minutes per unit, and per technician, over the whole run.
  unitBusyMinutes: Map<string, number>;
  technicianBusyMinutes: Map<string, number>;
  unitCount: number;
  horizonMinutes: number;
  // How long each policy invocation took, in milliseconds. Not reproducible.
  decisionMillis: number[];
  decisionCount: number;
};

type UnitState = {
  unit: UnitSnapshot;
  freeAtMinute: number;
  lat: number | null;
  lng: number | null;
};

// A job waiting to be dispatched, with the minute it became available. A job
// whose first visit failed rejoins this list after the coordination delay.
type Pending = { entry: ScenarioJob; availableFrom: number };

export async function runScenario(
  scenario: Scenario,
  policy: Policy,
  options: RunOptions = {},
): Promise<RunResult> {
  const zonePartitionThreshold = options.zonePartitionThreshold ?? ZONE_PARTITION_THRESHOLD;
  const records = new Map<string, JobRecord>();
  for (const entry of scenario.jobs) {
    records.set(entry.job.id, {
      jobId: entry.job.id,
      arrivalMinute: entry.arrivalMinute,
      trueFault: entry.trueFault,
      slaResponseMinutes: entry.job.slaResponseMinutes,
      dispatchCount: 0,
      firstArrivalMinute: null,
      resolvedMinute: null,
      firstVisitResolved: false,
      stockoutFailures: 0,
      resolvedBy: null,
    });
  }

  const units = new Map<string, UnitState>();
  for (const unit of scenario.snapshot.units) {
    units.set(unit.id, { unit, freeAtMinute: 0, lat: unit.lat, lng: unit.lng });
  }

  // WHAT IS ACTUALLY IN EACH VAN, as opposed to what a policy believes. The
  // quantities start from the scenario and go DOWN as repairs consume them, so
  // a busy van runs itself out over a shift — a stockout the harness produces
  // rather than one it was told about. Confidence is not tracked here: nobody
  // in a simulated run walks out and counts a shelf, so a van's count only
  // gets staler, which is the pessimistic direction and the honest one.
  const vanStock = new Map<string, Map<string, number>>();
  for (const line of scenario.snapshot.parts?.stock ?? []) {
    const shelf = vanStock.get(line.unitId) ?? new Map<string, number>();
    shelf.set(line.sku, line.quantity);
    vanStock.set(line.unitId, shelf);
  }

  const unitBusyMinutes = new Map<string, number>();
  const technicianBusyMinutes = new Map<string, number>();
  const decisionMillis: number[] = [];

  const pending: Pending[] = scenario.jobs.map((entry) => ({
    entry,
    availableFrom: entry.arrivalMinute,
  }));
  const jobZone = new Map(scenario.jobs.map((entry) => [entry.job.id, entry.zoneId]));

  let clock = 0;
  let decisionCount = 0;

  while (clock <= scenario.horizonMinutes) {
    const ready = pending.filter((item) => item.availableFrom <= clock);

    if (ready.length > 0) {
      const snapshot = snapshotAt(scenario, units, vanStock, clock);
      const now = new Date(SCENARIO_START.getTime() + clock * 60_000);
      const jobs = ready.map((item) => item.entry.job);

      const startedAt = performance.now();
      const decisions = await policy.decide({
        jobs,
        snapshot,
        now,
        jobZone,
        zonePartitionThreshold,
      });
      decisionMillis.push(performance.now() - startedAt);
      decisionCount += 1;

      for (const decision of decisions) {
        const item = ready.find((candidate) => candidate.entry.job.id === decision.jobId);
        const unitState = units.get(decision.option.unitId);
        if (!item || !unitState) continue;

        applyDispatch({
          clock,
          decision,
          entry: item.entry,
          record: records.get(decision.jobId)!,
          unitState,
          shelf: vanStock.get(decision.option.unitId) ?? null,
          unitBusyMinutes,
          technicianBusyMinutes,
          pending,
        });

        // Remove it from the pending list; a failed first visit puts it back
        // with a later `availableFrom`, inside applyDispatch.
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
      }
    }

    const next = nextEventMinute(pending, units, clock, scenario.horizonMinutes);
    if (next === null) break;
    clock = next;
  }

  return {
    scenario: scenario.name,
    policy: policy.name,
    jobs: [...records.values()],
    unitBusyMinutes,
    technicianBusyMinutes,
    unitCount: scenario.snapshot.units.length,
    horizonMinutes: scenario.horizonMinutes,
    decisionMillis,
    decisionCount,
  };
}

// ---------------------------------------------------------------------------
// One dispatch, played forward to whatever it turns into.

function applyDispatch(input: {
  clock: number;
  decision: PolicyDecision;
  entry: ScenarioJob;
  record: JobRecord;
  unitState: UnitState;
  // What is really on this van, mutated as the repair consumes it. Null when
  // the scenario models no parts at all.
  shelf: Map<string, number> | null;
  unitBusyMinutes: Map<string, number>;
  technicianBusyMinutes: Map<string, number>;
  pending: Pending[];
}): void {
  const { clock, decision, entry, record, unitState, shelf } = input;
  const option = decision.option;

  // A crew diverting through a depot to collect a part is genuinely later.
  // A stock-blind policy never plans one, so it never pays this — and never
  // arrives with the part either.
  const travelMinutes = option.estimatedTravelMinutes + option.partSourcing.detourMinutes;
  const arrivesAt = clock + travelMinutes;
  record.dispatchCount += 1;
  if (record.firstArrivalMinute === null) record.firstArrivalMinute = arrivesAt;

  // CAN THIS CREW ACTUALLY FIX IT? Two separate questions from Phase 19 on,
  // and keeping them apart is the point: `skillResolvableFaults` is what the
  // pair is trained and equipped to do, and the shelf is what they have to do
  // it WITH. A policy that ignored stock still meets the real shelf here — the
  // world does not become stockless because a dispatcher was not looking.
  const hasSkill = option.skillResolvableFaults.includes(entry.trueFault);
  const needed = partSkusForFault(entry.trueFault);
  const fromVan = needed.filter((sku) => (shelf?.get(sku) ?? 0) > 0);
  const collected = needed.filter((sku) => collectedOnTheWay(option, sku));
  const hasParts =
    shelf === null || needed.every((sku) => fromVan.includes(sku) || collected.includes(sku));

  const canResolve = hasSkill && hasParts;
  // The crew turned up qualified and could not finish for want of a part.
  if (hasSkill && !hasParts) record.stockoutFailures += 1;

  const workMinutes = canResolve
    ? resolveMinutes(entry.trueFault)
    : diagnoseMinutes(entry.trueFault);
  const releasedAt = arrivesAt + workMinutes;

  unitState.freeAtMinute = releasedAt;
  // The crew is now wherever the job was. A unit does not teleport home.
  unitState.lat = entry.job.lat;
  unitState.lng = entry.job.lng;

  const busy = travelMinutes + workMinutes;
  addMinutes(input.unitBusyMinutes, option.unitId, busy);
  addMinutes(input.technicianBusyMinutes, option.technicianId, busy);

  if (canResolve) {
    // The repair used the parts up. Only what came off THIS van comes off this
    // van — anything picked up at a depot never sat on the shelf.
    for (const sku of fromVan) shelf!.set(sku, (shelf!.get(sku) ?? 0) - 1);
    record.resolvedMinute = releasedAt;
    record.resolvedBy = option.technicianId;
    if (record.dispatchCount === 1) record.firstVisitResolved = true;
    return;
  }

  // A wasted visit. The vehicle is still broken, and the job goes back into
  // the queue after the coordination delay a real re-dispatch costs.
  input.pending.push({
    entry,
    availableFrom: releasedAt + REDISPATCH_COORDINATION_MINUTES,
  });
}

// A SKU the crew was sent to a depot for. The run collects exactly what it was
// sent for, so a part nobody planned around is not magically in the van.
function collectedOnTheWay(option: PolicyDecision['option'], sku: string): boolean {
  return (
    option.partSourcing.status === 'WORKSHOP_RUN' && option.partSourcing.missingSkus.includes(sku)
  );
}

function addMinutes(into: Map<string, number>, key: string, minutes: number): void {
  into.set(key, (into.get(key) ?? 0) + minutes);
}

// ---------------------------------------------------------------------------
// The world as the policy sees it at one instant.

function snapshotAt(
  scenario: Scenario,
  units: Map<string, UnitState>,
  vanStock: Map<string, Map<string, number>>,
  clock: number,
): DispatchSnapshot {
  // A technician who has dropped out is gone from the snapshot entirely, so
  // every policy loses them at the same moment and in the same way.
  const droppedOut = new Set(
    scenario.dropouts.filter((dropout) => dropout.atMinute <= clock).map((d) => d.technicianId),
  );

  const availableUnits = [...units.values()].map((state) => ({
    ...state.unit,
    lat: state.lat,
    lng: state.lng,
    currentTechnicianId:
      state.unit.currentTechnicianId && !droppedOut.has(state.unit.currentTechnicianId)
        ? state.unit.currentTechnicianId
        : null,
    // A unit mid-job is ON_JOB, which the production feasibility filter
    // rejects with UNIT_UNAVAILABLE — invariant 7, enforced by the same code
    // the application uses rather than by the harness holding units back.
    status: (state.freeAtMinute > clock ? 'ON_JOB' : 'AVAILABLE') as UnitSnapshot['status'],
  }));

  const parts = scenario.snapshot.parts;

  return {
    units: availableUnits,
    technicians: scenario.snapshot.technicians.filter(
      (technician) => !droppedOut.has(technician.id),
    ),
    shifts: scenario.snapshot.shifts,
    zones: scenario.snapshot.zones,
    // Quantities are re-read from the running totals, so a van that has used
    // its last battery stops being offered for battery jobs — the same
    // information a real consumption declaration writes back in production.
    parts: parts
      ? {
          ...parts,
          stock: parts.stock.map((line) => ({
            ...line,
            quantity: vanStock.get(line.unitId)?.get(line.sku) ?? line.quantity,
          })),
        }
      : null,
  };
}

// The next minute anything can possibly change: a job becoming available, or a
// unit finishing. Jumping straight there is what makes this event-driven.
function nextEventMinute(
  pending: Pending[],
  units: Map<string, UnitState>,
  clock: number,
  horizon: number,
): number | null {
  let next = Number.POSITIVE_INFINITY;

  for (const item of pending) {
    if (item.availableFrom > clock && item.availableFrom < next) next = item.availableFrom;
  }
  for (const state of units.values()) {
    if (state.freeAtMinute > clock && state.freeAtMinute < next) next = state.freeAtMinute;
  }

  // Nothing pending and nothing running: the run is over even if the horizon
  // has not been reached.
  if (next === Number.POSITIVE_INFINITY) return null;
  if (next > horizon) return null;
  return next;
}
