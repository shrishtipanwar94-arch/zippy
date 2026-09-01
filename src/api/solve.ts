// POST /solve — run the solver over every pending job and return three plans.
//
// REPLACES THE PHASE 4 DROPDOWN. A dispatcher no longer picks a unit from a
// list; they see plan A, B and C — the same feasible options assigned three
// different ways under the three named weight vectors — and choose between
// whole plans. The old `PATCH /jobs/:id/assign` and its `jobAssignment`
// permission are gone.
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
import { solve } from '../engine/solve.js';
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
    })),
    rejected: outcome.rejected.map((rejection) => ({
      jobId: rejection.jobId,
      unitId: rejection.option.unitId,
      code: rejection.code,
      detail: rejection.detail,
    })),
  });
});
