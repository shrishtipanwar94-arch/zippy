// RECORDING A DECISION — the only write in the whole solve path.
//
// This is deliberately NOT in src/engine. The solver is a pure function over
// a snapshot (invariant 2) and stays that way; writing down what it decided
// is a mutation, and mutations live in /src/commit. Keeping the split means
// the Phase 10 harness can run `solve()` thousands of times with no database
// at all, and this file is only reached when a real dispatcher run wants an
// audit trail.
//
// WHAT GETS WRITTEN, and why each part earns its row:
//   solver_runs      — the run itself: which snapshot, how long it took, how
//                      many options existed and how many survived. The
//                      snapshot hash is what makes a past decision
//                      reproducible: same hash, same world, same plans.
//   dispatch_options — EVERY option, feasible or not, each with its
//                      rejection code or its cost breakdown. The rejected
//                      ones are the point — "why not the nearer van?" is
//                      answered from this table, and an answer that only
//                      exists in a log line is not an answer.
//   plan_variants    — the three plans A/B/C, each with its assignments and
//                      what it would cost.
//
// It writes nothing else. No unit is held, no job is assigned, no offer is
// made — those are Phases 11 and 12, and until they exist a plan is a
// recommendation, not a reservation.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { SolverOutcome } from '../engine/solve.js';

export type PersistSolverRunInput = {
  outcome: SolverOutcome;
  // What caused this run — a new job, a technician declining, a manual
  // dispatcher refresh. Stored so Phase 10 can slice measurements by trigger.
  trigger: string;
  // Set when the run was triggered by one specific job, null for a periodic
  // or zone-wide re-plan.
  jobId: string | null;
};

export async function persistSolverRun(
  db: PrismaClient,
  input: PersistSolverRunInput,
): Promise<string> {
  const { outcome, trigger, jobId } = input;

  // One transaction: a SolverRun whose options or plans failed to write would
  // be a decision record that cannot explain itself, which is worse than no
  // record at all.
  return db.$transaction(async (tx) => {
    const run = await tx.solverRun.create({
      data: {
        jobId,
        trigger,
        snapshotHash: outcome.snapshotHash,
        optionCount: outcome.optionCount,
        feasibleCount: outcome.feasibleCount,
        wallClockMs: outcome.wallClockMs,
        zonePartitioned: outcome.zonePartitioned,
        timedOut: outcome.timedOut,
        // Kept on the run as well as expanded into dispatch_options below:
        // this is the summary an operator reads first, and it survives even
        // if the per-option rows are ever pruned.
        rejected: outcome.rejected.map((rejection) => ({
          jobId: rejection.jobId,
          unitId: rejection.option.unitId,
          technicianId: rejection.option.technicianId,
          code: rejection.code,
          detail: rejection.detail,
        })) satisfies Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    await writeRejectedOptions(tx, run.id, outcome);
    await writeFeasibleOptions(tx, run.id, outcome);
    await writePlans(tx, run.id, jobId, outcome);

    return run.id;
  });
}

async function writeRejectedOptions(
  tx: Prisma.TransactionClient,
  solverRunId: string,
  outcome: SolverOutcome,
): Promise<void> {
  if (outcome.rejected.length === 0) return;

  await tx.dispatchOption.createMany({
    data: outcome.rejected.map((rejection) => ({
      solverRunId,
      jobId: rejection.jobId,
      unitId: rejection.option.unitId,
      technicianId: rejection.option.technicianId,
      estimatedTravelMinutes: rejection.option.estimatedTravelMinutes,
      coveredFaultProbability: rejection.option.coveredFaultProbability,
      missingCapabilities: rejection.option.missingCapabilities,
      feasible: false,
      rejectionCode: rejection.code,
      rejectionDetail: rejection.detail,
    })),
  });
}

// Only the assignments actually chosen carry a cost breakdown here — an
// option scored under three weight vectors has three different totals, and
// writing all three per option would triple the table to record numbers
// nobody asked for. The chosen ones are what the "Why this technician?"
// panel needs.
async function writeFeasibleOptions(
  tx: Prisma.TransactionClient,
  solverRunId: string,
  outcome: SolverOutcome,
): Promise<void> {
  const chosen = new Map<string, { jobId: string; assignment: SolverOutcome['plans'][number]['assignments'][number] }>();

  for (const plan of outcome.plans) {
    for (const assignment of plan.assignments) {
      const key = `${assignment.jobId} ${assignment.unitId} ${plan.label}`;
      chosen.set(key, { jobId: assignment.jobId, assignment });
    }
  }
  if (chosen.size === 0) return;

  await tx.dispatchOption.createMany({
    data: [...chosen.values()].map(({ jobId, assignment }) => ({
      solverRunId,
      jobId,
      unitId: assignment.unitId,
      technicianId: assignment.technicianId,
      // The option's own measured figures, not values reverse-engineered from
      // the cost breakdown. Before the plan carried its option these columns
      // held `expectedTimeToResolution` under a name that says travel, which
      // is a different quantity — the audit row said one thing and meant
      // another.
      estimatedTravelMinutes: assignment.option.estimatedTravelMinutes,
      coveredFaultProbability: assignment.option.coveredFaultProbability,
      missingCapabilities: assignment.option.missingCapabilities,
      feasible: true,
      costBreakdown: assignment.cost satisfies Prisma.InputJsonValue,
      totalCost: assignment.cost.total,
    })),
  });
}

async function writePlans(
  tx: Prisma.TransactionClient,
  solverRunId: string,
  jobId: string | null,
  outcome: SolverOutcome,
): Promise<void> {
  for (const plan of outcome.plans) {
    await tx.planVariant.create({
      data: {
        solverRunId,
        jobId,
        label: plan.label,
        assignments: plan.assignments.map((assignment) => ({
          jobId: assignment.jobId,
          unitId: assignment.unitId,
          technicianId: assignment.technicianId,
          totalCost: assignment.cost.total,
        })) satisfies Prisma.InputJsonValue,
        metrics: {
          assignedCount: plan.assignments.length,
          unassignedCount: plan.unassignedJobIds.length,
          unassignedJobIds: plan.unassignedJobIds,
        } satisfies Prisma.InputJsonValue,
        totalCost: plan.totalCost,
      },
    });
  }
}
