// WHERE A MESSAGE BECOMES OPERATIONAL STATE — and the human in the middle.
//
// INVARIANT 5 IN CODE. The classifier flags; this file is the only thing that
// applies; and it applies nothing until a person has confirmed. There is
// deliberately NO function here that takes a message and changes a job. The
// two halves are `flagPromotions` (writes a FLAGGED row, touches nothing else)
// and `confirmPromotion` (requires an actor, a decision, and a role the policy
// table allows).
//
// A message silently rewriting a dispatch location is how a technician is sent
// to the wrong place with no audit trail. So every applied change carries
// PROVENANCE in both directions: the JobEvent payload names the promotion and
// the message it came from, and the promotion row stores the id of the event it
// produced. From any dispatch change you can reach the sentence a human typed,
// and from the sentence you can reach what it did.
//
// THE RE-SOLVE IS NOT DONE HERE. `confirmPromotion` returns the trigger the
// change implies, if any, and the caller fires it after the transaction
// commits. Re-solving inside this transaction would hold it open across a whole
// solve, and `handleTrigger` opens transactions of its own.

import type { Prisma, PrismaClient, PromotionKind, Role } from '@prisma/client';
import type { Classification, PromotionPayload } from '../domain/messageClassifier.js';
import { escalatedSafetyLevel, mayConfirm } from '../domain/promotionPolicy.js';
import type { ReplanTrigger } from '../domain/replanTriggers.js';
import { isMaterialMove } from '../domain/replanTriggers.js';
import { isOnHighway } from '../domain/location.js';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

// ---------------------------------------------------------------------------
// FLAGGING. Writes rows and nothing else. Runs inside the message's own
// transaction so a message and the flags it raised commit together — a flag
// pointing at a message that was rolled back would be unexplainable.

export type FlagInput = {
  jobId: string;
  messageId: string | null;
  classifications: Classification[];
};

export async function flagPromotions(
  tx: Prisma.TransactionClient,
  input: FlagInput,
): Promise<string[]> {
  const ids: string[] = [];
  for (const classification of input.classifications) {
    const row = await tx.eventPromotion.create({
      data: {
        jobId: input.jobId,
        messageId: input.messageId,
        kind: classification.kind,
        status: 'FLAGGED',
        proposedPayload: {
          ...classification.proposedPayload,
          matched: classification.matched,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// CONFIRMING.

export type ConfirmInput = {
  promotionId: string;
  decision: 'CONFIRMED' | 'REJECTED';
  actor: { role: Role; id: string | null };
};

export type ConfirmOutcome =
  | {
      outcome: 'APPLIED';
      kind: PromotionKind;
      jobId: string;
      jobEventId: string;
      // The re-solve this change implies, for the caller to fire after commit.
      trigger: ReplanTrigger | null;
    }
  | { outcome: 'REJECTED'; kind: PromotionKind; jobId: string }
  // Somebody else got there first. Two people can be looking at the same
  // flagged message.
  | { outcome: 'ALREADY_RESOLVED'; status: string }
  | { outcome: 'NOT_YOURS'; kind: PromotionKind }
  | { outcome: 'NOT_FOUND' };

export async function confirmPromotion(
  db: PrismaClient,
  input: ConfirmInput,
): Promise<ConfirmOutcome> {
  const promotion = await db.eventPromotion.findUnique({
    where: { id: input.promotionId },
    select: { id: true, jobId: true, messageId: true, kind: true, status: true, proposedPayload: true },
  });
  if (!promotion) return { outcome: 'NOT_FOUND' };

  // THE ROUTING RULE, enforced before anything is written. A dispatcher cannot
  // confirm a safety change on the driver's behalf — they cannot see the
  // traffic, and the point of asking the driver is that they can.
  if (!mayConfirm(promotion.kind, input.actor.role)) {
    return { outcome: 'NOT_YOURS', kind: promotion.kind };
  }

  return runPublishingTransaction(db, async (tx) => {
    // THE ARBITER. A conditional update on the status we expect to be leaving,
    // the same shape holds.ts and offers.ts use. Two operators pressing confirm
    // on the same flagged message would otherwise both apply it, and a job
    // would be moved twice and carry two provenance events for one sentence.
    const claimed = await tx.eventPromotion.updateMany({
      where: { id: promotion.id, status: 'FLAGGED' },
      data: {
        status: input.decision,
        confirmedByRole: input.actor.role,
        confirmedById: input.actor.id,
        confirmedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      const current = await tx.eventPromotion.findUnique({
        where: { id: promotion.id },
        select: { status: true },
      });
      return { outcome: 'ALREADY_RESOLVED', status: current?.status ?? 'REJECTED' } as const;
    }

    if (input.decision === 'REJECTED') {
      // Nothing is written to the job. A dismissed flag leaves the promotion
      // row as the only record, which is the correct amount: somebody looked
      // and said no.
      return { outcome: 'REJECTED', kind: promotion.kind, jobId: promotion.jobId } as const;
    }

    const payload = (promotion.proposedPayload ?? {}) as PromotionPayload;
    const applied = await applyPromotion(tx, {
      jobId: promotion.jobId,
      kind: promotion.kind,
      payload,
    });

    const eventId = await writeProvenanceEvent(tx, {
      jobId: promotion.jobId,
      eventType: applied.eventType,
      payload: {
        ...applied.eventPayload,
        // PROVENANCE, BOTH WAYS. From this event you can reach the promotion
        // and the message; the promotion row below points back at this event.
        promotionId: promotion.id,
        messageId: promotion.messageId,
        confirmedByRole: input.actor.role,
      },
      actor: input.actor,
    });

    await tx.eventPromotion.update({
      where: { id: promotion.id },
      data: { jobEventId: eventId },
    });

    return {
      outcome: 'APPLIED',
      kind: promotion.kind,
      jobId: promotion.jobId,
      jobEventId: eventId,
      trigger: applied.trigger,
    } as const;
  });
}

// ---------------------------------------------------------------------------
// WHAT EACH KIND ACTUALLY DOES. One branch per kind, each saying plainly what
// it changes and — where it matters more — what it deliberately does not.

type AppliedChange = {
  eventType: string;
  eventPayload: Record<string, unknown>;
  trigger: ReplanTrigger | null;
};

async function applyPromotion(
  tx: Prisma.TransactionClient,
  input: { jobId: string; kind: PromotionKind; payload: PromotionPayload },
): Promise<AppliedChange> {
  if (input.kind === 'SAFETY_CHANGE') return applySafetyChange(tx, input.jobId);
  if (input.kind === 'LOCATION_CORRECTION') return applyLocationCorrection(tx, input.jobId, input.payload);

  if (input.kind === 'ACCESS_RESTRICTION') {
    // NO COLUMN, AND THAT IS HONEST. There is nowhere on `jobs` to put "there
    // is a divider between the van and the car", and inventing a text field
    // the feasibility engine cannot read would look like a feature and be a
    // note. So it IS a note — an event, visible to the technician and the
    // dispatcher before anyone drives out. Making access a real routing
    // constraint needs the road graph, which is Phase 22's territory.
    return {
      eventType: 'ACCESS_RESTRICTION_NOTED',
      eventPayload: { note: input.payload.note ?? null },
      trigger: null,
    };
  }

  // DIAGNOSIS_DETAIL. Written as a note and NOT as a hypothesis update, which
  // is the important half. A driver's message must never move the fault
  // distribution: that is what the on-site diagnosis route is for, it is
  // TECHNICIAN-only (permissions.jobDiagnosis), and letting chat reach it would
  // route dispatch on what a stressed person guessed about their own engine.
  return {
    eventType: 'DIAGNOSIS_DETAIL_NOTED',
    eventPayload: { note: input.payload.note ?? null },
    trigger: null,
  };
}

async function applySafetyChange(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<AppliedChange> {
  const job = await tx.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { safetyLevel: true },
  });

  const escalated = escalatedSafetyLevel(job.safetyLevel);
  if (!escalated) {
    // Already HIGH_RISK. The confirmation is still recorded — a driver saying
    // "yes I am blocking traffic" is worth having on the record — but nothing
    // changes and no re-solve is triggered for a level that did not move.
    return {
      eventType: 'SAFETY_LEVEL_CONFIRMED',
      eventPayload: { safetyLevel: job.safetyLevel, changed: false },
      trigger: null,
    };
  }

  await tx.job.update({
    where: { id: jobId },
    data: { safetyLevel: escalated, version: { increment: 1 } },
  });

  return {
    eventType: 'SAFETY_LEVEL_CHANGED',
    eventPayload: { from: job.safetyLevel, to: escalated, changed: true },
    // Invariant 4: safety sits lexicographically above cost, so a job that has
    // just become HIGH_RISK must be re-ranked rather than left where the old
    // level put it.
    trigger: 'SAFETY_LEVEL_CHANGED',
  };
}

async function applyLocationCorrection(
  tx: Prisma.TransactionClient,
  jobId: string,
  payload: PromotionPayload,
): Promise<AppliedChange> {
  const job = await tx.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { lat: true, lng: true, roadPosition: true },
  });

  const data: Prisma.JobUpdateInput = {};
  if (payload.lat !== undefined && payload.lng !== undefined) {
    data.lat = payload.lat;
    data.lng = payload.lng;
  }
  if (payload.roadPosition) {
    // ONE FACT, ONE HOME — location.ts's rule, applied here too. `on_highway`
    // is never supplied, always derived from the position, so a corrected
    // position cannot leave the two disagreeing.
    data.roadPosition = payload.roadPosition;
    data.onHighway = isOnHighway(payload.roadPosition);
  }

  const moved =
    payload.lat !== undefined &&
    payload.lng !== undefined &&
    job.lat !== null &&
    job.lng !== null &&
    isMaterialMove({ lat: job.lat, lng: job.lng }, { lat: payload.lat, lng: payload.lng });

  if (Object.keys(data).length > 0) {
    data.version = { increment: 1 };
    await tx.job.update({ where: { id: jobId }, data });
  }

  return {
    eventType: 'LOCATION_CORRECTED',
    eventPayload: {
      from: { lat: job.lat, lng: job.lng, roadPosition: job.roadPosition },
      to: {
        lat: payload.lat ?? job.lat,
        lng: payload.lng ?? job.lng,
        roadPosition: payload.roadPosition ?? job.roadPosition,
      },
      materialMove: moved,
    },
    // Only a MATERIAL move re-solves. The 250-metre threshold is the same one
    // that stops a GPS ping storm re-planning the board (replanTriggers.ts) —
    // correcting a landmark should not re-dispatch a van that is already
    // outside the door.
    trigger: moved ? 'DRIVER_MOVED_MATERIALLY' : null,
  };
}

// `appendJobEvent` returns the sequence, not the row id, and the promotion
// needs the id to point at. One small read rather than changing a signature
// four phases of code already depend on.
async function writeProvenanceEvent(
  tx: Prisma.TransactionClient,
  input: {
    jobId: string;
    eventType: string;
    payload: Record<string, unknown>;
    actor: { role: Role; id: string | null };
  },
): Promise<string> {
  const sequence = await appendJobEvent(tx, {
    jobId: input.jobId,
    eventType: input.eventType,
    payload: input.payload as Prisma.InputJsonValue,
    actorRole: input.actor.role,
    actorId: input.actor.id,
  });

  const event = await tx.jobEvent.findFirstOrThrow({
    where: { jobId: input.jobId, sequence },
    select: { id: true },
  });
  return event.id;
}
