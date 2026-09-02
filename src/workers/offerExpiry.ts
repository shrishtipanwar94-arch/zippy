// THE OFFER-EXPIRY QUEUE — real work from Phase 11. `proposeOffer`
// (src/commit/offers.ts) schedules one delayed job per offer; this processor
// is the thing that actually enforces the deadline.
//
// IT RACES THE TECHNICIAN, ON PURPOSE. An accept arriving as this fires is
// the interesting case, and it is not resolved here — it is resolved by the
// conditional UPDATE inside `timeoutOffer`, which moves the row only while it
// is still PROPOSED. Whichever writer gets there first wins; the loser is
// told what happened instead of erroring. That is why this processor can be
// as simple as it is.
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
import { prismaBase } from '../infra/prismaBase.js';
import { timeoutOffer } from '../commit/offers.js';
import { advanceSaga } from '../commit/saga.js';
import { recordAcceptanceOutcome } from '../commit/destinationAcceptance.js';

// A HYPHEN, NOT A COLON. BullMQ rejects a custom job id containing `:` — it
// uses colons as separators in its own Redis key layout, so one inside an id
// would split a key. This function was written in Phase 5 with a colon and
// never called, so the validation error sat undiscovered until Phase 11 made
// real offers schedule real expiries. `deduplication.id` (queues/debounce.ts)
// has no such restriction, which is why the solver's `zone:...` key is fine.
function offerExpiryJobId(offerId: string): string {
  return `offer-expiry-${offerId}`;
}

export async function scheduleOfferExpiry(offerId: string, expiresAt: Date): Promise<void> {
  const delay = Math.max(0, expiresAt.getTime() - Date.now());
  // The retry budget and backoff come from the queue's own defaultJobOptions
  // (set once in queues.ts) — only jobId and delay are specific to this call.
  await queues['offer-expiry'].add('expire-offer', { offerId }, { jobId: offerExpiryJobId(offerId), delay });
}

export async function processOfferExpiry(job: Job<{ offerId: string }>): Promise<void> {
  await runIdempotently('offer-expiry', job.id!, async () => {
    // NOT run on the transaction `runIdempotently` provides. That transaction
    // exists to make the log row and the effect commit together, and it works
    // when the effect is a plain write on the same connection. `timeoutOffer`
    // opens its own transaction because it is also called directly, outside a
    // queue, and nesting an interactive transaction inside another one on the
    // same client is not something Prisma supports. The redundancy is
    // acceptable here precisely because the effect is already idempotent by
    // construction: a second delivery finds the offer no longer PROPOSED and
    // changes nothing.
    const result = await timeoutOffer(prismaBase, { offerId: job.data.offerId });

    // THE GAP THIS CLOSES, found while auditing which re-plan triggers have a
    // real event source. Timing the offer out moved the offer row and stopped
    // there: the SAGA that offer belonged to stayed in AWAITING_LEGS forever,
    // holding its unit, until the recovery sweep noticed hours later. The
    // technician had gone quiet and the van stayed reserved for them.
    //
    // Advancing the saga is what turns a timeout into the compensation it
    // always should have been: the hold is released, the job goes back to
    // PLANNED, and the unit is on the board again. `advanceSaga` is
    // idempotent and refuses to act on a terminal saga, so an accept that
    // landed first is not undone by this.
    const offer = await prismaBase.technicianOffer.findUnique({
      where: { id: job.data.offerId },
      select: { dispatchOfferId: true },
    });
    if (offer?.dispatchOfferId) {
      // THE THIRD LEG SHARES THIS DEADLINE (Phase 22) — startSaga gives a
      // destination offer the SAME `expiresAt` as the technician offer it
      // rides alongside (saga.ts's own comment says so), so one scheduled
      // expiry is enough for both: there is no separate destination-expiry
      // queue to keep in sync with this one. A workshop that has gone quiet
      // times out here, exactly like a technician who has.
      const destination = await prismaBase.destinationOffer.findFirst({
        where: { dispatchOfferId: offer.dispatchOfferId, status: 'PROPOSED' },
        select: { id: true, jobId: true, workshopId: true },
      });
      if (destination) {
        const at = new Date();
        const moved = await prismaBase.destinationOffer.updateMany({
          where: { id: destination.id, status: 'PROPOSED' },
          data: { status: 'TIMEOUT', respondedAt: at },
        });
        // Same "only the writer that actually moved the row" rule
        // recordDestinationDecision follows — a redelivery that finds this
        // already resolved must not record a second outcome for it.
        if (moved.count > 0) {
          await recordAcceptanceOutcome(prismaBase, {
            destinationOfferId: destination.id,
            jobId: destination.jobId,
            workshopId: destination.workshopId,
            outcome: 'TIMEOUT',
            at,
          });
        }
      }

      await advanceSaga(prismaBase, offer.dispatchOfferId);
    }

    await job.log(`offer ${job.data.offerId}: ${result.outcome} (${result.status})`);
  });
}
