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

  const outcome = await solve({
    jobs,
    snapshot,
    now: new Date(),
    jobZone,
    zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
  });

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

  res.json({
    solverRunId,
    snapshotHash: outcome.snapshotHash,
    jobCount: jobs.length,
    optionCount: outcome.optionCount,
    feasibleCount: outcome.feasibleCount,
    zonePartitioned: outcome.zonePartitioned,
    wallClockMs: outcome.wallClockMs,
    plans: outcome.plans,
    rejected: outcome.rejected.map((rejection) => ({
      jobId: rejection.jobId,
      unitId: rejection.option.unitId,
      code: rejection.code,
      detail: rejection.detail,
    })),
  });
});
