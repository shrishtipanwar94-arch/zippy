// TECHNICIAN OFFERS — PROPOSED, then exactly one of ACCEPTED, DECLINED or
// TIMEOUT.
//
// THE RACE THAT MATTERS. A technician taps Accept at the same moment the
// offer-expiry job fires. Two writers, one row, and the two outcomes are not
// merely different — they are contradictory. If both land, a job is both
// assigned to someone and timed out for reassignment, and the system will
// happily send two vans.
//
// The fix is the same shape as the unit hold's: the transition is a
// CONDITIONAL UPDATE on the state we expect to be leaving. `WHERE status =
// 'PROPOSED'` means the first writer to arrive moves the row and every later
// writer changes nothing and is told so. There is no window between checking
// the status and changing it, because it is one statement.
//
// WHY NOT A TRANSACTION WITH A SELECT FIRST. `SELECT … then UPDATE` inside a
// transaction still needs `FOR UPDATE` to be safe at READ COMMITTED, which is
// Postgres's default and what this project runs at. The conditional update
// gets the same guarantee without holding a lock, and reads as the rule it
// enforces.

import type { PrismaClient } from '@prisma/client';
import type { OfferStatus } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { scheduleOfferExpiry } from '../workers/offerExpiry.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

// How long a technician has to answer before the offer times out and the job
// goes back to the solver. Short: a roadside job that sits waiting on an
// unanswered phone is a job nobody is driving to. Not a measured figure.
export const DEFAULT_OFFER_TTL_MS = 45 * 1000;

export type ProposeOfferInput = {
  jobId: string;
  technicianId: string;
  ttlMs?: number;
  // Set when the offer belongs to a hold, so declining can release it.
  holdId?: string | null;
  // How the expiry gets scheduled. Defaults to the real queue; the
  // concurrency suite passes a no-op because it is proving a database race and
  // has no business needing a Redis to do it. Injected rather than mocked, the
  // same seam candidates.ts uses for travel time.
  scheduleExpiry?: (offerId: string, expiresAt: Date) => Promise<void>;
};

export async function proposeOffer(
  db: PrismaClient,
  input: ProposeOfferInput,
): Promise<{ offerId: string; expiresAt: Date }> {
  const ttlMs = input.ttlMs ?? DEFAULT_OFFER_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const offer = await runPublishingTransaction(db, async (tx) => {
    const created = await tx.technicianOffer.create({
      data: {
        jobId: input.jobId,
        technicianId: input.technicianId,
        status: 'PROPOSED',
        expiresAt,
      },
      select: { id: true },
    });

    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'TECHNICIAN_OFFER_SENT',
      payload: { offerId: created.id, technicianId: input.technicianId, expiresAt: expiresAt.toISOString() },
    });

    return created;
  });

  // Scheduled AFTER the transaction commits. Scheduling inside it would queue
  // an expiry for an offer a rollback then erased — the same publish-after-
  // commit rule the realtime outbox exists for, applied to a queue.
  await (input.scheduleExpiry ?? scheduleOfferExpiry)(offer.id, expiresAt);

  return { offerId: offer.id, expiresAt };
}

// ---------------------------------------------------------------------------
// The one transition function. Accept, decline and timeout differ only in the
// status they move to and who is asking, so they are one conditional update
// rather than three near-identical copies of it.

export type OfferOutcome =
  | { outcome: 'RECORDED'; status: OfferStatus }
  // Somebody got there first. Carries what actually happened, because the
  // caller's next move depends on it: a technician who accepted a
  // just-timed-out offer must be told the job is gone, not shown an error.
  | { outcome: 'ALREADY_RESOLVED'; status: OfferStatus };

export type RespondInput = {
  offerId: string;
  status: Extract<OfferStatus, 'ACCEPTED' | 'DECLINED'>;
  at?: Date;
};

export async function respondToOffer(
  db: PrismaClient,
  input: RespondInput,
): Promise<OfferOutcome> {
  return transitionOffer(db, {
    offerId: input.offerId,
    to: input.status,
    at: input.at ?? new Date(),
    // A technician may answer right up to the deadline. The expiry job is what
    // enforces the deadline, and it races this fairly — whoever updates the
    // PROPOSED row first wins.
    onlyIfExpired: false,
  });
}

// Called by the offer-expiry worker. `onlyIfExpired` is what stops a
// prematurely-fired or replayed expiry job from timing out an offer that is
// still legitimately open.
export async function timeoutOffer(
  db: PrismaClient,
  input: { offerId: string; at?: Date },
): Promise<OfferOutcome> {
  return transitionOffer(db, {
    offerId: input.offerId,
    to: 'TIMEOUT',
    at: input.at ?? new Date(),
    onlyIfExpired: true,
  });
}

async function transitionOffer(
  db: PrismaClient,
  input: { offerId: string; to: OfferStatus; at: Date; onlyIfExpired: boolean },
): Promise<OfferOutcome> {
  return runPublishingTransaction(db, async (tx) => {
    const offer = await tx.technicianOffer.findUnique({
      where: { id: input.offerId },
      select: { id: true, jobId: true, technicianId: true, status: true, sentAt: true, expiresAt: true },
    });
    if (!offer) return { outcome: 'ALREADY_RESOLVED', status: 'WITHDRAWN' } as const;

    const latencyMs = input.at.getTime() - offer.sentAt.getTime();

    // THE ONE STATEMENT THAT ARBITRATES. Everything above is reading; this is
    // the only thing that decides. `status = 'PROPOSED'` is the guard, and the
    // expiry clause is folded into the same WHERE rather than checked before
    // it — checking separately would reopen the window this closes.
    const moved = input.onlyIfExpired
      ? await tx.$executeRaw`
          UPDATE technician_offers
             SET status = ${input.to}::"OfferStatus", responded_at = ${input.at},
                 response_latency_ms = ${latencyMs}, version = version + 1
           WHERE id = ${input.offerId}
             AND status = 'PROPOSED'
             AND expires_at <= ${input.at}
        `
      : await tx.$executeRaw`
          UPDATE technician_offers
             SET status = ${input.to}::"OfferStatus", responded_at = ${input.at},
                 response_latency_ms = ${latencyMs}, version = version + 1
           WHERE id = ${input.offerId}
             AND status = 'PROPOSED'
        `;

    if (moved === 0) {
      const current = await tx.technicianOffer.findUnique({
        where: { id: input.offerId },
        select: { status: true },
      });
      return { outcome: 'ALREADY_RESOLVED', status: current?.status ?? 'WITHDRAWN' } as const;
    }

    await appendJobEvent(tx, {
      jobId: offer.jobId,
      eventType: `TECHNICIAN_OFFER_${input.to}`,
      payload: { offerId: offer.id, technicianId: offer.technicianId, latencyMs },
      actorRole: 'TECHNICIAN',
      actorId: offer.technicianId,
    });

    return { outcome: 'RECORDED', status: input.to } as const;
  });
}
