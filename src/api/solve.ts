// POST /solve — run the solver over every pending job and return the competing
// plans, one per named weight vector.
//
// REPLACES THE PHASE 4 DROPDOWN. A dispatcher no longer picks a unit from a
// list; they see the same feasible options assigned several different ways —
// BALANCED is recommended, the others are overrides — and choose between whole
// plans. The old `PATCH /jobs/:id/assign` and its `jobAssignment` permission
// are gone.
//
// NOTHING IS RESERVED HERE. The response is a recommendation: no unit is
// held, no offer is sent, no job row changes. Holds are Phase 11 and the
// reservation saga is Phase 12. Until they exist, choosing a plan is
// something a dispatcher does with their eyes.
//
// The only write is the SolverRun audit record (persistSolverRun), and that
// happens outside the engine for the reason invariant 2 exists.

import { Router } from 'express';
import { prismaBase } from '../infra/prismaBase.js';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { buildDispatchSnapshot } from '../commit/dispatchSnapshot.js';
import { persistSolverRun } from '../commit/persistSolverRun.js';
import { solve, RECOMMENDED_PLAN } from '../engine/solve.js';
import { raiseContentionApprovals } from '../commit/contention.js';
import { deprioritisedConsumerJobs } from '../domain/contractContention.js';
import { isChaosOn } from '../chaos/switches.js';
import { FORCED_TIMEOUT_DEADLINE_MS, SOLVE_DEADLINE_MS } from '../workers/solver.js';

export const solveRouter = Router();

solveRouter.post('/solve', authenticate, requirePermission('read', 'solverRun'), async (_req, res) => {
  // The snapshot is read on the UNSCOPED client on purpose: a solver run
  // plans across the whole fleet, and a DISPATCHER is already the only role
  // that can reach this route. Scoping the read to one tenant would produce
  // plans that quietly ignore units the dispatcher genuinely commands.
  const { jobs, snapshot, jobZone } = await buildDispatchSnapshot(prismaBase);

  if (jobs.length === 0) {
    res.json({ plans: [], rejected: [], jobCount: 0, message: 'no pending jobs to plan' });
    return;
  }

  // THE SAME DEADLINE THE QUEUED PATH USES (Phase 17). Both roads to the
  // planner have to behave the same under the chaos switch, or a demo would
  // show a timeout on one and not the other — and an operator pressing Solve
  // during a real slowdown would get different behaviour from the automatic
  // re-plan happening beside it.
  const forcedTimeout = await isChaosOn(prismaBase, 'SOLVER_TIMEOUT');

  const outcome = await solve({
    jobs,
    snapshot,
    now: new Date(),
    jobZone,
    zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
    deadlineMs: forcedTimeout ? FORCED_TIMEOUT_DEADLINE_MS : SOLVE_DEADLINE_MS,
  });

  if (outcome.timedOut) {
    logger.warn(
      { unplanned: outcome.unplannedJobIds.length, forced: forcedTimeout },
      'planner hit its deadline — unreached jobs keep their current assignment',
    );
  }

  if (outcome.zonePartitioned) {
    logger.info(
      { optionCount: outcome.optionCount, threshold: config.SOLVER_ZONE_PARTITION_THRESHOLD },
      'solver partitioned by zone — a job near a boundary may lose a better cross-zone option',
    );
  }

  const solverRunId = await persistSolverRun(prismaBase, {
    outcome,
    trigger: 'DISPATCHER_MANUAL',
    jobId: null,
  });

  // CROSS-TENANT CONTENTION IS ESCALATED, NEVER DECIDED. The solver has already
  // named the units a contract job and a consumer job both wanted at the same
  // safety level and priced both sides; this turns each into an APPROVE card.
  // It happens after persistSolverRun because the card refers to a decision
  // that has to exist to be argued with.
  await raiseContentionApprovals(prismaBase, outcome.contestedResources);

  // Consumer jobs a plan leaves waiting that the RECOMMENDED plan would have
  // served — the PROTECT_CONTRACTS trade-off, named per plan so the console can
  // put it on the card. Computed here rather than in the engine because it is a
  // comparison BETWEEN plans, which is a question about the response rather
  // than about any one assignment.
  const consumerJobIds = jobs
    .filter((job) => (job.contract?.breachPenaltyPaise ?? 0) <= 0)
    .map((job) => job.id);
  const recommended = outcome.plans.find((plan) => plan.label === RECOMMENDED_PLAN);

  // The engine returns plans as in-memory objects; `persistSolverRun` writes a
  // `plan_variants` row per plan. A dispatcher selecting a plan is pointing at
  // one of those ROWS, so the response has to carry their ids — without them
  // the console can show three plans and take none of them.
  const variants = await prismaBase.planVariant.findMany({
    where: { solverRunId },
    select: { id: true, label: true },
  });
  const variantByLabel = new Map(variants.map((variant) => [variant.label, variant.id]));

  res.json({
    solverRunId,
    snapshotHash: outcome.snapshotHash,
    jobCount: jobs.length,
    optionCount: outcome.optionCount,
    feasibleCount: outcome.feasibleCount,
    zonePartitioned: outcome.zonePartitioned,
    wallClockMs: outcome.wallClockMs,
    plans: outcome.plans.map((plan) => ({
      ...plan,
      planVariantId: variantByLabel.get(plan.label) ?? null,
      deprioritisedConsumerJobIds: deprioritisedConsumerJobs({
        protectPlanUnassignedJobIds: plan.unassignedJobIds,
        recommendedPlanUnassignedJobIds: recommended?.unassignedJobIds ?? [],
        consumerJobIds,
      }),
    })),
    contestedResources: outcome.contestedResources,
    rejected: outcome.rejected.map((rejection) => ({
      jobId: rejection.jobId,
      unitId: rejection.option.unitId,
      code: rejection.code,
      detail: rejection.detail,
    })),
  });
});
