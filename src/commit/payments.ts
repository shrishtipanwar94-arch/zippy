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

import type { PaymentStatus, Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../infra/prismaErrors.js';
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
    select: { id: true, status: true, gatewayOrderRef: true },
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
  //
  // FIND-OR-CREATE, DECIDED BY THE UNIQUE INDEX — and this is a race the Phase
  // 22b checkout route made reachable.
  //
  // TWO CALLERS now authorise the same job. The dispatch path calls
  // `authoriseCalloutQuietly` when the reservation commits, and the driver's
  // phone calls POST /jobs/:id/checkout when they tap Pay now. Both can be in
  // flight at once — a driver watching the page tap the button while the saga
  // is still committing is not a contrived interleaving, it is somebody being
  // quick — and read-then-create means both read "no payment", both insert, and
  // the loser dies on `idempotency_key` with a 500 in the driver's face for a
  // payment that was in fact created correctly by the other caller.
  //
  // PRISMA'S `upsert` IS NOT THE FIX, which was worth discovering: it compiles
  // to a select followed by an insert rather than to `INSERT ... ON CONFLICT`,
  // so it narrows the window without closing it. Three concurrent callers still
  // collide, and tests/concurrency/payments.test.ts proves it against a real
  // Postgres.
  //
  // Catching the violation and re-reading is the shape the rest of this
  // codebase already uses — `postTransaction` returns ALREADY_POSTED the same
  // way, and so do the completion code and the stock confirmations. The
  // constraint is the arbiter, and the loser simply reads the winner's row.
  const payment = existing ?? (await findOrCreatePayment(db, {
    jobId: job.id,
    tenantId: job.tenantId,
    amountPaise: callout.feePaise,
  }));

  const result = await provider.authorise({
    idempotencyKey: `auth-${job.id}`,
    amountPaise: callout.feePaise,
    currency: 'INR',
    reference: job.id,
    // WHAT WE ALREADY OPENED. A gateway that cannot place a hold synchronously
    // opens an order instead, and this row is the record of that — so a retry
    // reuses it rather than opening a second one. The stub ignores this; see
    // `knownOrderRef` in src/payments/provider.ts for the Stage 2 measurement
    // that made our own row the authority rather than a query against Razorpay.
    knownOrderRef: payment.gatewayOrderRef ?? undefined,
  });

  if (result.outcome !== 'AUTHORISED') {
    await flagPendingAuthorisation(db, {
      jobId: job.id,
      paymentId: payment.id,
      reason: result.reason,
      outcome: result.outcome,
      // PHASE 22b. A real gateway cannot place a hold synchronously — Razorpay
      // opens an ORDER and the customer completes a checkout afterwards — so
      // the reference to that order arrives on a non-AUTHORISED outcome and is
      // the only handle the checkout screen, the webhook and the reconciliation
      // sweep have on this payment. Storing it does not change what this
      // function DECIDES: an order awaiting a customer is a flagged
      // PENDING_AUTHORISATION and the job dispatches anyway, exactly as an
      // unreachable gateway always did.
      orderRef: result.outcome === 'AWAITING_CUSTOMER' ? result.orderRef : null,
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

// The insert, and the read that follows losing the race for it. Returns the
// same shape either way, so the caller cannot tell — and does not need to —
// whether it made the row or found it.
type PaymentRow = { id: string; status: PaymentStatus; gatewayOrderRef: string | null };

async function findOrCreatePayment(
  db: PrismaClient,
  input: { jobId: string; tenantId: string | null; amountPaise: number },
): Promise<PaymentRow> {
  // ONE KEY PER JOB'S AUTHORISATION. Derived from the job id rather than
  // random, so a retry of this whole function reuses it and the provider
  // recognises the repeat instead of placing a second hold — and so this
  // insert has something stable to collide on.
  const idempotencyKey = `auth-${input.jobId}`;
  const select = { id: true, status: true, gatewayOrderRef: true } as const;

  try {
    return await db.payment.create({
      data: {
        jobId: input.jobId,
        tenantId: input.tenantId,
        method: 'CARD',
        status: 'PENDING',
        amountPaise: input.amountPaise,
        idempotencyKey,
      },
      select,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Somebody else got there between our read and our insert. The row we
    // wanted exists; it is simply theirs.
    return db.payment.findUniqueOrThrow({ where: { idempotencyKey }, select });
  }
}

// THE DEGRADED STATE, MADE VISIBLE. Invariant 8: an operator sees it. The job
// event is what puts it on the dispatcher's incident timeline; the payment
// status is what the retry sweep looks for.
async function flagPendingAuthorisation(
  db: PrismaClient,
  input: {
    jobId: string;
    paymentId: string;
    reason: string;
    outcome: string;
    orderRef?: string | null;
  },
): Promise<boolean> {
  const flagged = await runPublishingTransaction(db, async (tx) => {
    // ONLY A TRANSITION IS AN EVENT. Asking again about an order that is still
    // waiting for the driver changes nothing, and must write nothing: the
    // driver's screen asks on every refresh, every job event is pushed to that
    // screen, and the screen refreshes on every push — so an event per ask was
    // a loop. Found walking the demo with Razorpay test keys: 2,521
    // PAYMENT_AUTHORISATION_PENDING events on one job in six minutes, about
    // seven a second, from one open driver page. The stub provider never takes
    // this branch, which is why no test saw it.
    const before = await tx.payment.findUnique({
      where: { id: input.paymentId },
      select: { status: true, gatewayOrderRef: true },
    });
    const alreadyPending = before?.status === 'PENDING_AUTHORISATION';
    const sameOrder = !input.orderRef || input.orderRef === before?.gatewayOrderRef;
    if (alreadyPending && sameOrder) return false;

    await tx.payment.update({
      where: { id: input.paymentId },
      data: {
        status: 'PENDING_AUTHORISATION',
        // Only ever written, never cleared: an order we opened stays findable
        // even after a later attempt failed to reach the gateway at all.
        ...(input.orderRef ? { gatewayOrderRef: input.orderRef } : {}),
      },
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
    return true;
  });
  if (!flagged) return false;

  logger.warn(
    { jobId: input.jobId, paymentId: input.paymentId, reason: input.reason },
    'callout authorisation failed; the job dispatches anyway',
  );
  return true;
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
    select: { id: true, status: true, externalRef: true, amountPaise: true, balanceOrderRef: true },
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
    balanceOrderRef: payment.balanceOrderRef,
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
  // The balance order the driver was shown at checkout, if any — passed to the
  // top-up authorisation so the provider checks THAT order rather than opening
  // a new one (see Payment.balanceOrderRef and src/commit/checkoutOrder.ts).
  balanceOrderRef?: string | null;
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
      knownOrderRef: input.balanceOrderRef ?? undefined,
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
