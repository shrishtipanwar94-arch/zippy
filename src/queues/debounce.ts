// "A DEBOUNCE HELPER FOR THE SOLVER QUEUE — MANY TRIGGERS IN A WINDOW COLLAPSE
// INTO ONE RUN. A RE-PLAN STORM IS A REAL FAILURE MODE."
//
// A job event firing five times in the same second (an intake answer, then a
// hypothesis update, then a safety re-triage) is not five reasons to re-plan a
// zone — it is one reason, told five times. Enqueueing a solver run per event
// would mean a busy zone re-plans continuously and never finishes a run before
// the next one invalidates it.
//
// BullMQ's job deduplication is the mechanism: `deduplication.id` names a
// window, `deduplication.ttl` is how long that name stays claimed, and `delay`
// is how long the resulting job waits before it is eligible to run. Given
// together, the FIRST call in a window creates a delayed job and claims the
// dedup id for `ttl` milliseconds; every call in that window after the first
// is absorbed — no new job is created, and Redis reports it as a dedup event.
// The one job that was created still runs `delay` milliseconds after the
// FIRST trigger, not the last. Verified in tests/queues.test.ts, because
// BullMQ's own docs describe several dedup modes (`extend`, `replace`,
// `keepLastIfActive`) and getting this comment wrong would defeat the point of
// writing it — this is the plain mode, none of those set.
//
// KNOWN LIMIT: a trigger that arrives while the debounced job is already
// ACTIVE (mid-run, not merely waiting) is not absorbed — deduplication only
// collapses jobs that are still delayed. A solver run slow enough to still be
// executing when the next debounce window opens gets a second run queued
// behind it. Not exercised today (nothing calls `enqueueDebounced` yet — the
// solver itself is Phase 6-9), and worth watching once it is.

import type { JobsOptions, Queue } from 'bullmq';

export async function enqueueDebounced(
  queue: Queue,
  jobName: string,
  dedupeKey: string,
  data: unknown,
  windowMs: number,
): Promise<void> {
  const options: JobsOptions = {
    delay: windowMs,
    deduplication: { id: dedupeKey, ttl: windowMs },
  };
  await queue.add(jobName, data, options);
}
