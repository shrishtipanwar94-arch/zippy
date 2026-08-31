// THE SOLVER QUEUE — now doing real work.
//
// A zone-wide re-plan, debounced. `enqueueSolve(zoneId)` is what every trigger
// calls (src/domain/replanTriggers.ts lists them), and the debounce is what
// stops a burst of triggers becoming a burst of solves — ten technicians
// going offline in the same minute is one re-plan, not ten.
//
// THE DEBOUNCE IS THE WHOLE POINT OF THIS FILE. A solve is expensive: it
// generates candidates for every pending job in a zone against every unit,
// which means routing calls. Ten of them back to back would be ten times the
// work to answer a question whose answer changed once. `enqueueDebounced`
// collapses them by dedupe key, and the key is the zone — because a re-plan
// for a zone subsumes every other re-plan for that zone.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { enqueueDebounced } from '../queues/debounce.js';
import { runIdempotently } from '../queues/idempotent.js';
import { prismaBase } from '../infra/prismaBase.js';
import { config } from '../infra/config.js';
import { buildDispatchSnapshot } from '../commit/dispatchSnapshot.js';
import { persistSolverRun } from '../commit/persistSolverRun.js';
import { solve } from '../engine/solve.js';

// How long a burst of triggers for the same zone is allowed to collapse into
// one run. Chosen to comfortably outlast the handful of job events one
// breakdown's intake produces in a row, without making a genuinely urgent
// re-plan wait long. Still an unmeasured guess, but now a load-bearing one:
// scripts/fire-10-triggers-fast.js fires ten triggers inside this window and
// asserts that `solver_runs` gains one or two rows rather than ten.
const SOLVE_DEBOUNCE_MS = 2_000;

export async function enqueueSolve(zoneId: string, trigger = 'ZONE_REPLAN'): Promise<void> {
  await enqueueDebounced(
    queues.solver,
    'solve-zone',
    `zone:${zoneId}`,
    { zoneId, trigger },
    SOLVE_DEBOUNCE_MS,
  );
}

export async function processSolver(job: Job<{ zoneId: string; trigger?: string }>): Promise<void> {
  await runIdempotently('solver', job.id!, async () => {
    // Not on the transaction runIdempotently offers: persistSolverRun opens
    // its own, and a solve is a long read that has no business holding one
    // open. The effect is naturally idempotent — a redelivery writes a second
    // SolverRun, which is an audit record of a second run, not a duplicated
    // side effect.
    const { jobs, snapshot, jobZone } = await buildDispatchSnapshot(prismaBase, {
      zoneId: job.data.zoneId,
    });
    if (jobs.length === 0) {
      await job.log(`zone ${job.data.zoneId}: nothing pending`);
      return;
    }

    const outcome = await solve({
      jobs,
      snapshot,
      now: new Date(),
      jobZone,
      zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
    });

    // EVERY RE-SOLVE IS LOGGED WITH ITS TRIGGER, so thrash is measurable:
    // `SELECT trigger, count(*) FROM solver_runs GROUP BY trigger` is the
    // question "what is making this system re-plan?" answered from data.
    const solverRunId = await persistSolverRun(prismaBase, {
      outcome,
      trigger: job.data.trigger ?? 'ZONE_REPLAN',
      jobId: null,
    });

    await job.log(
      `zone ${job.data.zoneId}: solved ${jobs.length} jobs, run ${solverRunId}, ${outcome.wallClockMs}ms`,
    );
  });
}
