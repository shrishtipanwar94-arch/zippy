// THE SOLVER QUEUE — PLUMBING, STILL WITHOUT A TRIGGER.
//
// The solver itself now exists: src/engine/solve.ts, reached synchronously by
// POST /solve when a dispatcher presses Solve. What does NOT exist yet is
// anything that decides on its own that a zone needs re-planning — a new job
// arriving, a diagnosis changing, a technician declining an offer. Those
// triggers are Phase 13 (re-dispatch), so nothing in this codebase calls
// `enqueueSolve`, and this processor has no real work to do until it does.
//
// That is deliberate rather than an oversight, and the ordering is the point:
// the queue, an idempotent processor, dead-lettering on exhaustion, and the
// debounce that keeps a burst of triggers from becoming a burst of runs all
// existed before there was a solver to run — so Phase 13 inherits them
// instead of inventing them under deadline.
//
// `enqueueSolve` is the stable name a trigger will call, so a re-plan becomes
// one call to this rather than a new queue.add() scattered at each call site.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { enqueueDebounced } from '../queues/debounce.js';
import { runIdempotently } from '../queues/idempotent.js';

// How long a burst of triggers for the same zone is allowed to collapse into
// one run. Chosen to comfortably outlast the handful of job events one
// breakdown's intake produces in a row, without making a genuinely urgent
// re-plan wait long. Still an unmeasured guess: Phase 9's solve reports its
// own `wallClockMs`, but with no trigger firing there is nothing yet to
// measure a burst against.
const SOLVE_DEBOUNCE_MS = 2_000;

export async function enqueueSolve(zoneId: string): Promise<void> {
  await enqueueDebounced(queues.solver, 'solve-zone', `zone:${zoneId}`, { zoneId }, SOLVE_DEBOUNCE_MS);
}

export async function processSolver(job: Job<{ zoneId: string }>): Promise<void> {
  await runIdempotently('solver', job.id!, async () => {
    // Deliberately does not call solve(). A background re-plan is only
    // useful if it can act on what it finds, and acting means holding a unit
    // and offering the job — Phases 11 and 12. Running the solver here today
    // would write a SolverRun nobody reads and change nothing, so this stays
    // a no-op until Phase 13 gives it a reason to exist.
    await job.log(`would re-plan zone ${job.data.zoneId} — no re-dispatch trigger yet (Phase 13)`);
  });
}
