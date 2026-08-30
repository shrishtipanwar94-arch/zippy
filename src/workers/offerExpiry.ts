// THE OFFER-EXPIRY QUEUE — PLUMBING ONLY, same status as solver.ts and
// notification.ts. `TechnicianOffer` (Phase 12's PROPOSED -> ACCEPTED |
// DECLINED | TIMEOUT) does not exist yet; nothing creates an offer, so nothing
// calls `scheduleOfferExpiry`.
//
// NOT DEBOUNCED, unlike solver and notification — and that is a real
// difference, not an inconsistency. Debouncing collapses many triggers for the
// SAME thing into one run. Every offer's expiry is its own thing: technician A
// declining does not change when technician B's separate offer times out. What
// this needs instead is "exactly one scheduled expiry per offer," which a
// fixed `jobId` gives for free — BullMQ silently ignores an add() whose jobId
// already exists, so calling this twice for the same offer (a bug, a resend)
// schedules it once.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { runIdempotently } from '../queues/idempotent.js';

function offerExpiryJobId(offerId: string): string {
  return `offer-expiry:${offerId}`;
}

export async function scheduleOfferExpiry(offerId: string, expiresAt: Date): Promise<void> {
  const delay = Math.max(0, expiresAt.getTime() - Date.now());
  // The retry budget and backoff come from the queue's own defaultJobOptions
  // (set once in queues.ts) — only jobId and delay are specific to this call.
  await queues['offer-expiry'].add('expire-offer', { offerId }, { jobId: offerExpiryJobId(offerId), delay });
}

export async function processOfferExpiry(job: Job<{ offerId: string }>): Promise<void> {
  await runIdempotently('offer-expiry', job.id!, async () => {
    // No TechnicianOffer to time out yet — that is Phase 12. This proves the
    // delayed-job mechanism and per-offer dedup work before anything real
    // depends on either.
    await job.log(`would expire offer ${job.data.offerId} — no offers exist yet (Phase 12)`);
  });
}
