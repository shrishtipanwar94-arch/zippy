// THE TWO-STAGE SPLIT — authorise what is known, capture what was agreed.
//
// You cannot charge the full amount before dispatch, because at dispatch
// nobody knows what it is. The fault is a probability distribution; it may be a
// ₹640 belt or a ₹2,340 alternator plus a tow. What IS known at dispatch is the
// callout fee — fixed, small, and owed the moment somebody drives out. So:
//
//   COMMIT      authorise the CALLOUT FEE ONLY.
//   DIAGNOSIS   the estimate is generated and the driver approves it (stage 2).
//   COMPLETION  the verification code is what TRIGGERS the capture. The
//               technician enters it, and that single action means "service
//               delivered" and releases the money.
//   CANCELLED   void, or capture exactly what the cancellation policy says.
//
// THE CODE TRIGGERING THE CAPTURE is the part worth defending. It could have
// been a status change, or a dispatcher pressing something. Tying it to the
// code means the money moves on the one signal that comes from the CUSTOMER's
// side of the transaction — the technician's "I am done" is a claim, and the
// code is the driver confirming it. Every other trigger would let a job be
// charged for on one party's word.
//
// PAYMENT IS NEVER ON THE DISPATCH CRITICAL PATH (invariant 8, and the phase
// brief says it twice). A stranded driver does not wait for a card to clear.
// Every function here that could fail returns rather than throws, the job
// proceeds regardless, and a failed authorisation becomes a flagged
// PENDING_AUTHORISATION that an operator can see and a sweep retries.
//
// TWO OF THE THREE PATHS NEVER CALL A GATEWAY AT ALL. A fleet is invoiced
// monthly and a covered consumer owes nothing — asking either for a card would
// be wrong, not merely unnecessary.

import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { usesGateway } from '../domain/settlementPath.js';
import { cancellationCharge, cancellationStageFor } from '../domain/cancellationPolicy.js';
import type { CancellationOutcome } from '../domain/cancellationPolicy.js';
import { calloutRate } from '../pricing/rateCard.js';
import { serviceTypeFor } from './settlement.js';
import { approvedPayableFor } from './estimates.js';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { paymentProvider } from '../payments/stubProvider.js';
import type { PaymentProvider } from '../payments/provider.js';

// Injected so a test can hand in a FailingStubProvider without touching the
// environment — the same seam candidates.ts uses for travel time. Defaults to
// whatever `setPaymentProvider` has installed, which in production is the stub
// and in an invariant-8 test is a provider that never answers.
type WithProvider = { provider?: PaymentProvider };

// ---------------------------------------------------------------------------
// COMMIT — authorise the callout fee, and nothing more.

export type AuthoriseOutcome =
  | { outcome: 'AUTHORISED'; paymentId: string; amountPaise: number }
  // A fleet or a covered consumer. No gateway, no payment row, nothing owed
  // at this point.
  | { outcome: 'NO_GATEWAY'; reason: string }
  // The provider said no, or we never heard back. THE JOB STILL DISPATCHES.
  | { outcome: 'PENDING_AUTHORISATION'; paymentId: string; reason: string }
  | { outcome: 'ALREADY_AUTHORISED'; paymentId: string }
  | { outcome: 'CANNOT_PRICE'; reason: string };

export async function authoriseCallout(
  db: PrismaClient,
  input: { jobId: string } & WithProvider,
): Promise<AuthoriseOutcome> {
  const provider = input.provider ?? paymentProvider();

  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: {
      id: true,
      tenantId: true,
      priceListId: true,
      createdAt: true,
      onHighway: true,
      settlementPath: true,
    },
  });
  if (!job) return { outcome: 'CANNOT_PRICE', reason: 'no such job' };

  if (!job.settlementPath || !usesGateway(job.settlementPath)) {
    return {
      outcome: 'NO_GATEWAY',
      reason: `${job.settlementPath ?? 'unknown'} jobs are not charged through a gateway`,
    };
  }

  const existing = await db.payment.findFirst({
    where: { jobId: job.id },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== 'PENDING_AUTHORISATION') {
    return { outcome: 'ALREADY_AUTHORISED', paymentId: existing.id };
  }

  if (!job.priceListId) return { outcome: 'CANNOT_PRICE', reason: 'this job has no pinned price list' };

  const callout = await calloutRate(db, {
    priceListId: job.priceListId,
    serviceType: serviceTypeFor(job.onHighway),
    at: job.createdAt,
  });
  if (!callout) return { outcome: 'CANNOT_PRICE', reason: 'the pinned price list has no callout fee' };

  // The payment row exists BEFORE the provider is called, so a provider that
  // never answers still leaves us something to show an operator and something
  // for the retry sweep to find. A row created only on success would make an
  // unreachable gateway indistinguishable from a job nobody tried to charge.
  const payment =
    existing ??
    (await db.payment.create({
      data: {
        jobId: job.id,
        tenantId: job.tenantId,
        method: 'CARD',
        status: 'PENDING',
        amountPaise: callout.feePaise,
        // ONE KEY PER JOB'S AUTHORISATION. Derived from the job id rather than
        // random, so a retry of this whole function reuses it and the provider
        // recognises the repeat instead of placing a second hold.
        idempotencyKey: `auth-${job.id}`,
      },
      select: { id: true, status: true },
    }));

  const result = await provider.authorise({
    idempotencyKey: `auth-${job.id}`,
    amountPaise: callout.feePaise,
    currency: 'INR',
    reference: job.id,
  });

  if (result.outcome !== 'AUTHORISED') {
    await flagPendingAuthorisation(db, {
      jobId: job.id,
      paymentId: payment.id,
      reason: result.reason,
      outcome: result.outcome,
    });
    return { outcome: 'PENDING_AUTHORISATION', paymentId: payment.id, reason: result.reason };
  }

  await runPublishingTransaction(db, async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'AUTHORISED', externalRef: result.externalRef },
    });
    await tx.authorisation.upsert({
      where: { paymentId: payment.id },
      update: {
        status: 'AUTHORISED',
        externalRef: result.externalRef,
        amountPaise: callout.feePaise,
        authorisedAt: new Date(),
        expiresAt: result.expiresAt,
      },
      create: {
        paymentId: payment.id,
        amountPaise: callout.feePaise,
        status: 'AUTHORISED',
        externalRef: result.externalRef,
        authorisedAt: new Date(),
        expiresAt: result.expiresAt,
      },
    });
    await recordPaymentEvent(tx, payment.id, 'AUTHORISED', {
      amountPaise: callout.feePaise,
      externalRef: result.externalRef,
    });
    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'CALLOUT_AUTHORISED',
      payload: { paymentId: payment.id, amountPaise: callout.feePaise },
    });
  });

  return { outcome: 'AUTHORISED', paymentId: payment.id, amountPaise: callout.feePaise };
}

// THE DEGRADED STATE, MADE VISIBLE. Invariant 8: an operator sees it. The job
// event is what puts it on the dispatcher's incident timeline; the payment
// status is what the retry sweep looks for.
async function flagPendingAuthorisation(
  db: PrismaClient,
  input: { jobId: string; paymentId: string; reason: string; outcome: string },
): Promise<void> {
  await runPublishingTransaction(db, async (tx) => {
    await tx.payment.update({
      where: { id: input.paymentId },
      data: { status: 'PENDING_AUTHORISATION' },
    });
    await recordPaymentEvent(tx, input.paymentId, 'AUTHORISATION_FAILED', {
      reason: input.reason,
      providerOutcome: input.outcome,
    });
    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'PAYMENT_AUTHORISATION_PENDING',
      payload: { paymentId: input.paymentId, reason: input.reason },
    });
  });

  logger.warn(
    { jobId: input.jobId, paymentId: input.paymentId, reason: input.reason },
    'callout authorisation failed; the job dispatches anyway',
  );
}

// The wrapper every dispatch-path caller should use. A failure to authorise
// must never fail the thing that called it — that is what "payment is never on
// the dispatch critical path" means in code.
export async function authoriseCalloutQuietly(db: PrismaClient, jobId: string): Promise<void> {
  try {
    await authoriseCallout(db, { jobId });
  } catch (error) {
    logger.error({ err: error, jobId }, 'could not authorise a callout fee');
  }
}

// ---------------------------------------------------------------------------
// COMPLETION — the verification code releases the money.

export type CaptureOutcome =
  | { outcome: 'CAPTURED'; paymentId: string; amountPaise: number; secondAuthorisation: boolean }
  | { outcome: 'NO_GATEWAY'; reason: string }
  | { outcome: 'NOTHING_TO_CAPTURE'; reason: string }
  // The capture failed. The job is still complete — the work was done — and
  // the money is chased afterwards rather than by refusing to finish the job.
  | { outcome: 'CAPTURE_FAILED'; paymentId: string; reason: string };

export async function captureOnCompletion(
  db: PrismaClient,
  input: { jobId: string } & WithProvider,
): Promise<CaptureOutcome> {
  const provider = input.provider ?? paymentProvider();

  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: { id: true, settlementPath: true },
  });
  if (!job) return { outcome: 'NOTHING_TO_CAPTURE', reason: 'no such job' };
  if (!job.settlementPath || !usesGateway(job.settlementPath)) {
    return {
      outcome: 'NO_GATEWAY',
      reason: `${job.settlementPath ?? 'unknown'} jobs are settled off the gateway`,
    };
  }

  // WHAT THE DRIVER ACTUALLY AGREED TO. Not the latest estimate, not the
  // technician's opinion — the approved total, which is stage 2's record of
  // consent. A job with no approval has nothing to capture.
  const approvedTotalPaise = await approvedPayableFor(db, job.id);
  if (approvedTotalPaise === null) {
    return { outcome: 'NOTHING_TO_CAPTURE', reason: 'nothing was approved on this job' };
  }
  // PAYABLE, not the work's total. A contract that absorbed the whole job
  // leaves nothing to take, and capturing the pre-coverage figure would charge
  // a customer for something their cover already paid for.
  if (approvedTotalPaise === 0) {
    return { outcome: 'NOTHING_TO_CAPTURE', reason: 'the contract covers this job in full' };
  }

  const payment = await db.payment.findFirst({
    where: { jobId: job.id },
    select: { id: true, status: true, externalRef: true, amountPaise: true },
  });
  if (!payment) return { outcome: 'NOTHING_TO_CAPTURE', reason: 'this job has no payment' };
  if (payment.status === 'CAPTURED') {
    return { outcome: 'CAPTURED', paymentId: payment.id, amountPaise: approvedTotalPaise, secondAuthorisation: false };
  }

  const captured = await captureAgainstPayment(db, provider, {
    jobId: job.id,
    paymentId: payment.id,
    authorisationRef: payment.status === 'AUTHORISED' ? payment.externalRef : null,
    heldPaise: payment.status === 'AUTHORISED' ? payment.amountPaise : 0,
    amountPaise: approvedTotalPaise,
    keyPrefix: 'complete',
  });
  if (captured.outcome === 'FAILED') {
    await recordCaptureFailure(db, job.id, payment.id, captured.reason);
    return { outcome: 'CAPTURE_FAILED', paymentId: payment.id, reason: captured.reason };
  }
  const secondAuthorisation = captured.secondAuthorisation;

  await runPublishingTransaction(db, async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'CAPTURED', amountPaise: approvedTotalPaise },
    });
    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'PAYMENT_CAPTURED',
      payload: { paymentId: payment.id, amountPaise: approvedTotalPaise, secondAuthorisation },
    });
  });

  return { outcome: 'CAPTURED', paymentId: payment.id, amountPaise: approvedTotalPaise, secondAuthorisation };
}

export async function captureOnCompletionQuietly(db: PrismaClient, jobId: string): Promise<void> {
  try {
    await captureOnCompletion(db, { jobId });
  } catch (error) {
    logger.error({ err: error, jobId }, 'could not capture on completion');
  }
}

// ---------------------------------------------------------------------------
// TAKING A SPECIFIC AMOUNT — the one place a capture happens, used by both
// completion and cancellation.
//
// TWO RULES LIVE HERE, and they are the two ways a naive implementation gets
// money wrong in opposite directions.
//
// NEVER TRUNCATE. The hold is for the callout fee only, because that is all
// anybody knew at dispatch, so almost every real capture is larger. Taking "as
// much as we happen to be holding" would silently bill a customer less than
// they approved and leave the business short. The shortfall gets its OWN
// authorisation and its own capture, and if that second authorisation fails
// the whole thing fails and is chased — it does not quietly become a smaller
// charge.
//
// NEVER LEAVE MONEY HELD. When the amount is SMALLER than the hold, the
// remainder is voided rather than left sitting on the customer's card until
// the provider's expiry. A hold nobody intends to take is a customer's money
// we have no business keeping.
type CaptureAttempt = {
  jobId: string;
  paymentId: string;
  authorisationRef: string | null;
  heldPaise: number;
  amountPaise: number;
  // Distinguishes a completion capture from a cancellation capture, so the two
  // can never collide on an idempotency key for the same job.
  keyPrefix: string;
};

type CaptureAttemptResult =
  | { outcome: 'CAPTURED'; secondAuthorisation: boolean; remainderVoided: boolean }
  | { outcome: 'FAILED'; reason: string };

async function captureAgainstPayment(
  db: PrismaClient,
  provider: PaymentProvider,
  input: CaptureAttempt,
): Promise<CaptureAttemptResult> {
  const fromHold = Math.min(input.heldPaise, input.amountPaise);
  const shortfall = input.amountPaise - input.heldPaise;

  let secondAuthorisation = false;
  let topUpRef: string | null = null;

  if (shortfall > 0) {
    const topUp = await provider.authorise({
      idempotencyKey: `${input.keyPrefix}-auth2-${input.jobId}`,
      amountPaise: shortfall,
      currency: 'INR',
      reference: input.jobId,
    });
    if (topUp.outcome !== 'AUTHORISED') {
      return { outcome: 'FAILED', reason: `second authorisation: ${topUp.reason}` };
    }
    secondAuthorisation = true;
    topUpRef = topUp.externalRef;
  }

  // The original hold first, then the top-up: two captures against two
  // authorisations, because that is what the provider is actually holding.
  const attempts: { ref: string; amountPaise: number; key: string }[] = [];
  if (fromHold > 0 && input.authorisationRef) {
    attempts.push({
      ref: input.authorisationRef,
      amountPaise: fromHold,
      key: `${input.keyPrefix}-cap-${input.jobId}`,
    });
  }
  if (topUpRef && shortfall > 0) {
    attempts.push({
      ref: topUpRef,
      amountPaise: shortfall,
      key: `${input.keyPrefix}-cap2-${input.jobId}`,
    });
  }

  for (const attempt of attempts) {
    const result = await provider.capture({
      idempotencyKey: attempt.key,
      authorisationRef: attempt.ref,
      amountPaise: attempt.amountPaise,
    });
    if (result.outcome !== 'CAPTURED') return { outcome: 'FAILED', reason: result.reason };

    await runPublishingTransaction(db, async (tx) => {
      await tx.capture.create({
        data: {
          paymentId: input.paymentId,
          amountPaise: attempt.amountPaise,
          idempotencyKey: attempt.key,
          externalRef: result.externalRef,
        },
      });
      await recordPaymentEvent(tx, input.paymentId, 'CAPTURED', {
        amountPaise: attempt.amountPaise,
        externalRef: result.externalRef,
      });
    });
  }

  // PARTIAL CAPTURE — the remainder goes back. Failing to void is not a
  // failure of the capture (the money we meant to take, we took), so it is
  // reported rather than thrown.
  let remainderVoided = false;
  if (input.authorisationRef && input.amountPaise < input.heldPaise) {
    const released = await provider.voidAuthorisation({
      idempotencyKey: `${input.keyPrefix}-void-${input.jobId}`,
      authorisationRef: input.authorisationRef,
    });
    remainderVoided = released.outcome === 'VOIDED';
    if (remainderVoided) {
      await runPublishingTransaction(db, async (tx) => {
        await recordPaymentEvent(tx, input.paymentId, 'REMAINDER_VOIDED', {
          heldPaise: input.heldPaise,
          capturedPaise: input.amountPaise,
        });
      });
    }
  }

  return { outcome: 'CAPTURED', secondAuthorisation, remainderVoided };
}

async function recordCaptureFailure(
  db: PrismaClient,
  jobId: string,
  paymentId: string,
  reason: string,
): Promise<void> {
  await runPublishingTransaction(db, async (tx) => {
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED' } });
    await recordPaymentEvent(tx, paymentId, 'CAPTURE_FAILED', { reason });
    await appendJobEvent(tx, {
      jobId,
      eventType: 'PAYMENT_CAPTURE_FAILED',
      payload: { paymentId, reason },
    });
  });
  logger.warn({ jobId, paymentId, reason }, 'capture failed; the job is complete and the money is owed');
}

// ---------------------------------------------------------------------------
// CANCELLATION — void, or capture exactly what the policy says.

export type CancellationSettlement =
  | { outcome: 'SETTLED'; action: 'VOID' | 'CAPTURE'; chargePaise: number }
  | { outcome: 'NO_GATEWAY'; reason: string }
  | { outcome: 'NOT_CANCELLABLE'; reason: string }
  | { outcome: 'FAILED'; reason: string };

export async function settleCancellation(
  db: PrismaClient,
  input: {
    jobId: string;
    // The status the job was in WHEN IT WAS CANCELLED. Passed in rather than
    // read, because by the time this runs the row already says CANCELLED and
    // the policy's whole question is what was happening before that.
    statusAtCancellation: Parameters<typeof cancellationStageFor>[0];
    partsConsumedPaise?: number;
  } & WithProvider,
): Promise<CancellationSettlement> {
  const provider = input.provider ?? paymentProvider();

  const stage = cancellationStageFor(input.statusAtCancellation);
  if (!stage) {
    return { outcome: 'NOT_CANCELLABLE', reason: `a ${input.statusAtCancellation} job cannot be cancelled` };
  }

  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: { id: true, settlementPath: true, priceListId: true, createdAt: true, onHighway: true },
  });
  if (!job) return { outcome: 'FAILED', reason: 'no such job' };

  const payment = await db.payment.findFirst({
    where: { jobId: job.id },
    select: { id: true, status: true, externalRef: true, amountPaise: true },
  });

  const calloutFeePaise = job.priceListId
    ? (
        await calloutRate(db, {
          priceListId: job.priceListId,
          serviceType: serviceTypeFor(job.onHighway),
          at: job.createdAt,
        })
      )?.feePaise ?? 0
    : 0;

  // THE POLICY DECIDES. Everything above is fetching; this is the only line
  // that judges, and it is a pure function anybody can read.
  const charge = cancellationCharge({
    stage,
    calloutFeePaise,
    partsConsumedPaise: input.partsConsumedPaise ?? 0,
  });

  // The decision is recorded for EVERY path, gateway or not — a fleet job
  // cancelled on scene still owes a callout fee, it just arrives on next
  // month's invoice rather than through a card.
  await recordCancellationDecision(db, job.id, charge);

  if (!job.settlementPath || !usesGateway(job.settlementPath)) {
    return { outcome: 'NO_GATEWAY', reason: 'settled against the contract, not a gateway' };
  }
  if (!payment?.externalRef) {
    return { outcome: 'NO_GATEWAY', reason: 'nothing was ever authorised on this job' };
  }

  if (charge.action === 'VOID') {
    const result = await provider.voidAuthorisation({
      idempotencyKey: `void-${job.id}`,
      authorisationRef: payment.externalRef,
    });
    if (result.outcome !== 'VOIDED') return { outcome: 'FAILED', reason: result.reason };

    await runPublishingTransaction(db, async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', amountPaise: 0 } });
      await recordPaymentEvent(tx, payment.id, 'VOIDED', { reason: charge.reason });
    });
    return { outcome: 'SETTLED', action: 'VOID', chargePaise: 0 };
  }

  // THE SAME CAPTURE PATH AS COMPLETION. An ON_SCENE cancellation charges the
  // callout fee PLUS the parts consumed, which is more than the callout-only
  // hold — so it needs the second authorisation exactly as a completion does,
  // and a separate copy of that logic here would be a second place to get it
  // wrong in a file about money.
  const captured = await captureAgainstPayment(db, provider, {
    jobId: job.id,
    paymentId: payment.id,
    authorisationRef: payment.externalRef,
    heldPaise: payment.status === 'AUTHORISED' ? payment.amountPaise : 0,
    amountPaise: charge.chargePaise,
    keyPrefix: 'cancel',
  });
  if (captured.outcome === 'FAILED') {
    await recordCaptureFailure(db, job.id, payment.id, captured.reason);
    return { outcome: 'FAILED', reason: captured.reason };
  }

  await runPublishingTransaction(db, async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'CAPTURED', amountPaise: charge.chargePaise },
    });
  });

  return { outcome: 'SETTLED', action: 'CAPTURE', chargePaise: charge.chargePaise };
}

async function recordCancellationDecision(
  db: PrismaClient,
  jobId: string,
  charge: CancellationOutcome,
): Promise<void> {
  await runPublishingTransaction(db, async (tx) => {
    await appendJobEvent(tx, {
      jobId,
      eventType: 'CANCELLATION_SETTLED',
      payload: {
        action: charge.action,
        chargePaise: charge.chargePaise,
        calloutFeePaise: charge.calloutFeePaise,
        partsConsumedPaise: charge.partsConsumedPaise,
        reason: charge.reason,
      },
    });
  });
}

// Gateway callbacks and our own attempts, in one append-only trail per
// payment. External origin, so `event_time` and `received_at` both — the stub
// is instantaneous, a real gateway will not be.
async function recordPaymentEvent(
  tx: Prisma.TransactionClient,
  paymentId: string,
  type: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  await tx.paymentEvent.create({
    data: { paymentId, type, payload, eventTime: new Date() },
  });
}
