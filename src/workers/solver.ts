// THE SOLVER QUEUE — PLUMBING ONLY. "Background work exists before anything
// depends on it."
//
// The solver itself (candidate generation, feasibility, the cost function,
// allocation) is Phases 6-9. Nothing in this codebase calls `enqueueSolve` yet
// — there is no zone-level trigger to call it from — and that is deliberately
// correct for this phase, not an oversight. What has to exist NOW, so those
// phases inherit it instead of inventing it under deadline, is: a queue that
// exists, a processor that is idempotent and dead-letters on exhaustion, and
// the debounce that keeps a burst of triggers from becoming a burst of runs.
//
// `enqueueSolve` is exported so Phase 6+ has a stable name to call — a re-plan
// trigger (a new job, a diagnosis change, a technician decline) becomes one
// call to this, not a new queue.add() scattered at each call site.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { enqueueDebounced } from '../queues/debounce.js';
import { runIdempotently } from '../queues/idempotent.js';

// How long a burst of triggers for the same zone is allowed to collapse into
// one run. Chosen to comfortably outlast the handful of job events one
// breakdown's intake produces in a row, without making a genuinely urgent
// re-plan wait long. Revisit once Phase 9 has a real run to time.
const SOLVE_DEBOUNCE_MS = 2_000;

export async function enqueueSolve(zoneId: string): Promise<void> {
  await enqueueDebounced(queues.solver, 'solve-zone', `zone:${zoneId}`, { zoneId }, SOLVE_DEBOUNCE_MS);
}

export async function processSolver(job: Job<{ zoneId: string }>): Promise<void> {
  await runIdempotently('solver', job.id!, async () => {
    // No allocation logic here — that is exactly what Phase 6-9 add. This
    // proves the queue is reachable, idempotent, and dead-letters correctly
    // before anything real depends on any of those properties.
    await job.log(`would solve zone ${job.data.zoneId} — no solver exists yet (Phase 6-9)`);
  });
}
