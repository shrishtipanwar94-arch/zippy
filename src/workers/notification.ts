// THE NOTIFICATION QUEUE — PLUMBING ONLY, same status as solver.ts.
//
// Real delivery (push, SMS, in-app) and real content are Phase 15b. Nothing
// calls `enqueueNotification` yet. What exists now is the coalescing the brief
// calls for: five job events for the same recipient in quick succession are
// one thing that happened to them, not five notifications landing at once.
//
// Coalescing reuses the exact debounce mechanism the solver queue uses —
// see queues/debounce.ts — keyed by recipient instead of by zone. It is the
// same problem (many triggers, one run) with a different key, which is why it
// is not a second implementation.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { enqueueDebounced } from '../queues/debounce.js';
import { runIdempotently } from '../queues/idempotent.js';

// Long enough to catch a burst from one job's intake (symptoms, safety,
// location, hypothesis land as separate events within milliseconds of each
// other); short enough that a genuinely time-sensitive notification is not
// noticeably late. A real number wants Phase 15b's actual message content to
// tune against, not a guess.
const NOTIFICATION_DEBOUNCE_MS = 3_000;

export async function enqueueNotification(recipientKey: string, data: unknown): Promise<void> {
  await enqueueDebounced(
    queues.notification,
    'notify',
    `recipient:${recipientKey}`,
    data,
    NOTIFICATION_DEBOUNCE_MS,
  );
}

export async function processNotification(job: Job): Promise<void> {
  await runIdempotently('notification', job.id!, async () => {
    // No delivery channel exists — that is Phase 15b. This proves the queue
    // is reachable, idempotent, and coalesces before any real message depends
    // on any of those properties.
    await job.log(`would notify — no delivery channel exists yet (Phase 15b): ${JSON.stringify(job.data)}`);
  });
}
