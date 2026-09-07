// THIS IS A SAGA, NOT 2PC. External actors (a technician's phone, a workshop's
// dispatcher) cannot be enrolled in a Postgres transaction, so failure
// handling is compensation, not rollback.
//
// Two-phase commit needs every participant to hold a prepared transaction open
// until the coordinator says commit. A technician's phone cannot do that: it
// is offline, or the screen is locked, or the answer takes ninety seconds. So
// the reservation is built the only way it can be — acquire each leg, and if a
// later one fails, run the earlier ones BACKWARDS to undo them.
//
// THE THREE LEGS, in acquisition order:
//   1. Unit hold        local, version-checked (holds.ts). Cheapest to undo.
//   2. Technician offer external actor: accept / decline / timeout.
//   3. Destination offer external actor, tow jobs only: accept / decline /
//                       timeout, exactly like a technician offer.
//
// Compensations run in REVERSE order — destination, then technician, then hold
// — because a later leg may depend on an earlier one still being in place.
// Releasing the unit first would leave a technician holding an offer for a van
// somebody else already took.
//
// THE CASE THAT MATTERS IS PARTIAL COMMIT: the technician ACCEPTED and the
// destination then DECLINED. Nothing failed, nothing crashed, and the
// reservation is still dead. Both legs release, the job requeues, and the
// technician is told explicitly — being left holding an assignment that
// silently evaporated is the worst outcome available, because they will drive
// to it.
//
// STATE IS PERSISTED, on dispatch_offers.state, because a process that dies
// mid-saga must not leave a unit held forever. `recoverSagas` is the startup
// routine that finishes or compensates whatever it finds.

import type { JobStatus, Prisma, PrismaClient, SagaState } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { createHold, releaseHold, consumeHold } from './holds.js';
import { proposeOffer, respondToOffer } from './offers.js';
import { recordReleaseCompensationQuietly } from './earnings.js';
import { recordAcceptanceOutcome } from './destinationAcceptance.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export const TERMINAL_STATES: SagaState[] = ['COMMITTED', 'REQUEUED'];

export type StartSagaInput = {
  jobId: string;
  unitId: string;
  technicianId: string;
  // The unit version the plan was computed against. Passed straight through to
  // the hold, where a stale value loses the race rather than taking a unit the
  // plan no longer describes.
  expectedUnitVersion: number;
  // Tow jobs acquire a third leg. Everything else is two.
  workshopId?: string | null;
  offerTtlMs?: number;
  holdTtlMs?: number;
  // Injected so a database-only test needs no broker; see offers.ts.
  scheduleExpiry?: (offerId: string, expiresAt: Date) => Promise<void>;
};

export type StartSagaResult =
  | { outcome: 'AWAITING_LEGS'; sagaId: string }
  // Leg 1 lost its race. Nothing was acquired, so there is nothing to
  // compensate — the saga is born terminal.
  | { outcome: 'REQUEUED'; sagaId: string; reason: string };

export async function startSaga(
  db: PrismaClient,
  input: StartSagaInput,
): Promise<StartSagaResult> {
  const saga = await db.dispatchOffer.create({
    data: {
      jobId: input.jobId,
      unitId: input.unitId,
      technicianId: input.technicianId,
      state: 'PROPOSED',
    },
    select: { id: true },
  });

  // LEG 1.
  const hold = await createHold(db, {
    unitId: input.unitId,
    jobId: input.jobId,
    expectedVersion: input.expectedUnitVersion,
    ttlMs: input.holdTtlMs,
  });

  if (hold.outcome === 'LOST_RACE') {
    await finishAsRequeued(db, saga.id, input.jobId, `unit unavailable: ${hold.detail}`);
    return { outcome: 'REQUEUED', sagaId: saga.id, reason: hold.detail };
  }

  await db.unitHold.update({
    where: { id: hold.holdId },
    data: { dispatchOfferId: saga.id },
  });

  // LEG 2.
  const offer = await proposeOffer(db, {
    jobId: input.jobId,
    technicianId: input.technicianId,
    ttlMs: input.offerTtlMs,
    scheduleExpiry: input.scheduleExpiry,
  });
  await db.technicianOffer.update({
    where: { id: offer.offerId },
    data: { dispatchOfferId: saga.id },
  });

  // THE JOB SAYS SO TOO. `OFFERED` has existed in the schema since Phase 1 and
  // nothing ever wrote it: the offer lived on `technician_offers` and
  // `dispatch_offers` while the job row stayed exactly as it was. The
  // consequence was visible to a customer — a van held, a named technician's
  // phone counting down forty-five seconds, and the driver's screen reading
  // "Finding someone equipped for this", because that is what
  // driverNarrative.ts returns for a job still marked INTAKE.
  //
  // CONDITIONAL, and the condition is what makes it safe. A saga whose write
  // arrives late must never drag a job backwards out of COMMITTED, so only the
  // two statuses a job can legitimately be offered FROM are named. Zero rows
  // affected means somebody else got there first, and that is not an error —
  // it is the same optimistic pattern every unit write in this file uses.
  await setJobStatus(db, input.jobId, 'OFFERED', ['INTAKE', 'PLANNED']);

  // LEG 3, tows only. The workshop side is a stub until Phase 22: the row is
  // real and the state machine treats it as a real leg, but nothing sends it
  // anywhere, so only a test or a future workshop adapter answers it.
  if (input.workshopId) {
    await db.destinationOffer.create({
      data: {
        jobId: input.jobId,
        workshopId: input.workshopId,
        dispatchOfferId: saga.id,
        status: 'PROPOSED',
        expiresAt: offer.expiresAt,
      },
    });

    // AND THE JOB SAYS IT IS WAITING ON A WORKSHOP, for the same reason leg 2
    // now says it has been offered. `AWAITING_DESTINATION` is the more precise
    // of the two — a job with both legs outstanding is waiting on the workshop
    // in a way a driver's screen already has words for ("Confirming a workshop
    // that can take your car").
    //
    // UNREACHABLE IN PRODUCTION TODAY, and deliberately written anyway. Nothing
    // can answer a destination offer — there is no workshop role, no route and
    // no adapter — so `executeReassignment` now refuses to start a saga that
    // would need one (see the guard there). This line exists so that the day a
    // counterparty is built, the status it should set is already correct rather
    // than being a second thing to remember.
    await setJobStatus(db, input.jobId, 'AWAITING_DESTINATION', ['INTAKE', 'PLANNED', 'OFFERED']);
  }

  await db.dispatchOffer.update({
    where: { id: saga.id },
    data: { state: 'AWAITING_LEGS' },
  });

  return { outcome: 'AWAITING_LEGS', sagaId: saga.id };
}

// MOVING THE JOB'S OWN STATUS, CONDITIONALLY.
//
// One helper rather than two inline `updateMany` calls, because the rule is the
// same both times and it is easy to get wrong in a way nothing would notice:
// an unconditional update here would let a slow write from an abandoned saga
// pull a committed job back to OFFERED. Naming the statuses it may move FROM
// makes the write safe without a version column, which is the same argument
// the unit hold makes one leg earlier.
async function setJobStatus(
  db: PrismaClient,
  jobId: string,
  to: JobStatus,
  from: JobStatus[],
): Promise<void> {
  await db.job.updateMany({ where: { id: jobId, status: { in: from } }, data: { status: to } });
}

// ---------------------------------------------------------------------------
// External actors answering. Each records its own leg and then asks the state
// machine what that means, rather than deciding for itself — so "all legs in"
// is evaluated in exactly one place.

export async function recordTechnicianDecision(
  db: PrismaClient,
  input: { sagaId: string; decision: 'ACCEPTED' | 'DECLINED' },
): Promise<SagaState> {
  const offer = await db.technicianOffer.findFirst({
    where: { dispatchOfferId: input.sagaId },
    select: { id: true },
  });
  if (offer) await respondToOffer(db, { offerId: offer.id, status: input.decision });
  return advanceSaga(db, input.sagaId);
}

export async function recordDestinationDecision(
  db: PrismaClient,
  input: { sagaId: string; decision: 'ACCEPTED' | 'DECLINED' },
): Promise<SagaState> {
  // Read before the conditional update, not after: the update's WHERE clause
  // is still what arbitrates the race (two answers landing for one offer),
  // but this file also needs to know WHICH offer and workshop it just moved,
  // to write the acceptance outcome below. Reading first and keying the
  // update on the row's own id rather than re-running the same WHERE twice
  // means both statements agree about which row they mean.
  const offer = await db.destinationOffer.findFirst({
    where: { dispatchOfferId: input.sagaId },
    select: { id: true, jobId: true, workshopId: true },
  });

  if (offer) {
    const moved = await db.destinationOffer.updateMany({
      where: { id: offer.id, status: 'PROPOSED' },
      data: { status: input.decision, respondedAt: new Date() },
    });

    // ONLY THE WRITER THAT ACTUALLY MOVED THE ROW records an outcome — the
    // same "whoever wins the conditional update owns the side effect" rule
    // holds.ts and offers.ts both follow. A redelivery that finds the offer
    // already resolved changes nothing here either.
    if (moved.count > 0) {
      await recordAcceptanceOutcome(db, {
        destinationOfferId: offer.id,
        jobId: offer.jobId,
        workshopId: offer.workshopId,
        outcome: input.decision,
        at: new Date(),
      });
    }
  }

  return advanceSaga(db, input.sagaId);
}

// ---------------------------------------------------------------------------
// THE STATE MACHINE. Reads every leg, decides, and is safe to call again —
// re-running it on a terminal saga returns the state and changes nothing.

export async function advanceSaga(db: PrismaClient, sagaId: string): Promise<SagaState> {
  const saga = await db.dispatchOffer.findUnique({
    where: { id: sagaId },
    select: {
      id: true,
      jobId: true,
      state: true,
      technicianOffers: { select: { status: true } },
      destinationOffers: { select: { status: true } },
    },
  });
  if (!saga) return 'REQUEUED';
  if (TERMINAL_STATES.includes(saga.state)) return saga.state;

  const technician = saga.technicianOffers[0]?.status ?? 'PROPOSED';
  const destination = saga.destinationOffers[0]?.status ?? null;

  // ANY leg failing kills the whole reservation. A declined destination with
  // an accepted technician is the partial-commit case, and it is handled by
  // exactly the same branch as every other failure — which is the point of
  // having one.
  const technicianFailed = technician === 'DECLINED' || technician === 'TIMEOUT';
  const destinationFailed = destination === 'DECLINED' || destination === 'TIMEOUT';
  if (technicianFailed || destinationFailed) {
    const reason = technicianFailed ? `technician ${technician}` : `destination ${destination}`;
    await compensateSaga(db, { sagaId, reason });
    return 'REQUEUED';
  }

  const technicianAccepted = technician === 'ACCEPTED';
  const destinationAccepted = destination === null || destination === 'ACCEPTED';
  if (!technicianAccepted || !destinationAccepted) return saga.state; // still waiting

  await db.dispatchOffer.update({ where: { id: sagaId }, data: { state: 'ALL_ACCEPTED' } });
  return commitSaga(db, sagaId);
}

// ---------------------------------------------------------------------------
// COMMIT. The hold becomes the assignment, in one transaction.

export async function commitSaga(db: PrismaClient, sagaId: string): Promise<SagaState> {
  const saga = await db.dispatchOffer.findUniqueOrThrow({
    where: { id: sagaId },
    select: {
      id: true,
      jobId: true,
      unitId: true,
      technicianId: true,
      state: true,
      unitHolds: { where: { status: 'ACTIVE' }, select: { id: true } },
    },
  });
  if (TERMINAL_STATES.includes(saga.state)) return saga.state;

  const hold = saga.unitHolds[0];
  if (!hold) {
    // The hold expired or was released underneath us — the reservation cannot
    // be honoured, so compensate rather than assign a unit we no longer own.
    await compensateSaga(db, { sagaId, reason: 'hold no longer active at commit' });
    return 'REQUEUED';
  }

  const consumed = await consumeHold(db, { holdId: hold.id });
  if (consumed.outcome !== 'CONSUMED') {
    await compensateSaga(db, { sagaId, reason: `hold ${consumed.status} at commit` });
    return 'REQUEUED';
  }

  await runPublishingTransaction(db, async (tx) => {
    await tx.job.update({
      where: { id: saga.jobId },
      data: {
        status: 'COMMITTED',
        assignedUnitId: saga.unitId,
        assignedTechnicianId: saga.technicianId,
        version: { increment: 1 },
      },
    });
    await tx.dispatchOffer.update({
      where: { id: sagaId },
      data: { state: 'COMMITTED', decidedAt: new Date() },
    });
    await appendJobEvent(tx, {
      jobId: saga.jobId,
      eventType: 'DISPATCH_COMMITTED',
      payload: { sagaId, unitId: saga.unitId, technicianId: saga.technicianId },
    });
  });

  return 'COMMITTED';
}

// ---------------------------------------------------------------------------
// COMPENSATION, IN REVERSE ORDER OF ACQUISITION.
//
// Idempotent throughout (invariant 6): every step is a conditional update that
// finds nothing to do on a second run. Compensating twice is a no-op, not a
// double release — which matters because recovery and a live response can both
// arrive at this function for the same saga.

export async function compensateSaga(
  db: PrismaClient,
  input: { sagaId: string; reason: string },
): Promise<SagaState> {
  const saga = await db.dispatchOffer.findUnique({
    where: { id: input.sagaId },
    select: {
      id: true,
      jobId: true,
      state: true,
      unitHolds: { select: { id: true, status: true } },
      technicianOffers: { select: { id: true, technicianId: true, status: true } },
      destinationOffers: { select: { id: true, status: true } },
    },
  });
  if (!saga) return 'REQUEUED';
  if (TERMINAL_STATES.includes(saga.state)) return saga.state;

  await db.dispatchOffer.update({
    where: { id: input.sagaId },
    data: { state: 'RELEASED_ALL' },
  });

  // LEG 3 first.
  await db.destinationOffer.updateMany({
    where: { dispatchOfferId: input.sagaId, status: 'PROPOSED' },
    data: { status: 'WITHDRAWN', respondedAt: new Date() },
  });

  // LEG 2. A technician who ACCEPTED is the partial-commit case and is told
  // explicitly; one who never answered is simply withdrawn. Both are recorded
  // as events, because a notification that was never delivered is not a
  // record of anything.
  for (const offer of saga.technicianOffers) {
    const wasAccepted = offer.status === 'ACCEPTED';
    await db.technicianOffer.updateMany({
      where: { id: offer.id, status: { in: ['PROPOSED', 'ACCEPTED'] } },
      data: { status: 'WITHDRAWN', respondedAt: new Date() },
    });
    await runPublishingTransaction(db, async (tx) => {
      await appendJobEvent(tx, {
        jobId: saga.jobId,
        eventType: wasAccepted ? 'TECHNICIAN_RELEASED_AFTER_ACCEPT' : 'TECHNICIAN_OFFER_WITHDRAWN',
        payload: { sagaId: input.sagaId, technicianId: offer.technicianId, reason: input.reason },
      });
    });

    // THE COMPENSATION SAGA CALLS THE MONEY DOMAIN — but only for a technician
    // who had ACCEPTED. That is the partial-commit case: they committed to the
    // job and may already be driving, and the reservation then fell apart
    // around them. A technician whose offer merely lapsed unanswered has lost
    // nothing and is owed nothing.
    //
    // IDEMPOTENT, AND IT HAS TO BE (invariant 6). This function is reachable
    // from a live response, from the offer-expiry worker and from startup
    // recovery, and all three can arrive for the same saga. The ledger's
    // transaction id is derived from the saga id and (transaction, account) is
    // unique, so a second call collides and writes nothing.
    //
    // `Quietly`: a compensation that cannot be booked must never stop the unit
    // being released. The technician is owed either way, and the failure is
    // logged rather than left to strand a van.
    if (wasAccepted) {
      await recordReleaseCompensationQuietly(db, {
        sagaId: input.sagaId,
        jobId: saga.jobId,
        technicianId: offer.technicianId,
      });
    }
  }

  // LEG 1 last: the unit is the thing everyone else was waiting on.
  for (const hold of saga.unitHolds) {
    if (hold.status !== 'ACTIVE') continue;
    await releaseHold(db, { holdId: hold.id, reason: `SAGA_COMPENSATED: ${input.reason}` });
  }

  await finishAsRequeued(db, input.sagaId, saga.jobId, input.reason);
  return 'REQUEUED';
}

// The job goes back on the board. Nothing CONSUMES this yet — the re-solve
// trigger list is Phase 13's, and defining one here would put the second copy
// of it in the codebase. What exists now is the durable fact: state REQUEUED
// and an event saying why.
async function finishAsRequeued(
  db: PrismaClient,
  sagaId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  await runPublishingTransaction(db, async (tx) => {
    await tx.dispatchOffer.update({
      where: { id: sagaId },
      data: { state: 'REQUEUED', decidedAt: new Date() },
    });
    await tx.job.updateMany({
      // Only if it never got committed — a job assigned by a LATER saga must
      // not be dragged back to PLANNED by an earlier one compensating.
      // AWAITING_DESTINATION joined this list when startSaga started writing
      // it. Without it a compensated tow would be left stranded in a state
      // nothing else moves out of — the list has to name every status the
      // forward path can put a job in before it commits.
      where: {
        id: jobId,
        status: { in: ['INTAKE', 'PLANNED', 'OFFERED', 'AWAITING_DESTINATION'] },
      },
      data: { status: 'PLANNED' },
    });
    await appendJobEvent(tx, {
      jobId,
      eventType: 'DISPATCH_REQUEUED',
      payload: { sagaId, reason } satisfies Prisma.InputJsonValue,
    });
  });
}
