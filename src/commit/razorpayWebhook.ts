// APPLYING A VERIFIED WEBHOOK. The signature has already been checked in
// src/api/webhooks.ts; by the time anything here runs we know the payload came
// from Razorpay.
//
// THREE THINGS GO WRONG WITH WEBHOOKS, and all three are normal operation
// rather than faults:
//
//   THEY ARRIVE TWICE. Razorpay redelivers until it gets a 2xx, and a 200 that
//   is slow to come back is retried anyway. The `gateway_events` row is
//   inserted in the SAME transaction as the state change it causes, so a
//   redelivery collides on `(provider, event_id)`, the whole transaction rolls
//   back, and the duplicate cannot apply half of anything. That is the entire
//   idempotency mechanism — there is no "have we seen this?" read to race with.
//
//   THEY ARRIVE OUT OF ORDER. `payment.captured` and `payment.authorized` are
//   fired independently and retried independently, so captured-before-
//   authorised is ordinary. `movesForward` in src/payments/gatewayState.ts is
//   the guard: a transition is applied only when it moves the payment forward,
//   so the late `authorized` is recorded and changes nothing rather than
//   walking a captured payment backwards.
//
//   THEY ARRIVE ABOUT SOMETHING WE HAVE NEVER HEARD OF. Which is the
//   interesting one, and the reason this is not the whole solution: if our
//   database write was lost, the local payment row may not carry the order ref
//   the event quotes. The event is stored UNMATCHED rather than dropped, and
//   src/commit/paymentReconciliation.ts is what closes it. A webhook cannot fix
//   a dual-write failure on its own — it is a message about a row we may not
//   have.

import type { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../infra/prismaErrors.js';
import { logger } from '../infra/logger.js';
import { movesForward } from '../payments/gatewayState.js';
import type { ParsedWebhook, PaymentWebhook, PayoutWebhook } from '../payments/razorpayEvents.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { settlePayoutOnLedger } from './payoutExecution.js';
import { advancePaymentTo, recordPaymentEvent } from './gatewayTransition.js';

export const RAZORPAY = 'razorpay';

// What we did about an event. Recorded on the row so an operator can answer
// "did that webhook do anything?" without replaying it.
export type WebhookOutcome =
  | 'APPLIED'
  | 'DUPLICATE' // the same event id, already handled
  | 'OUT_OF_ORDER' // it described a state at or behind the one we hold
  | 'UNMATCHED' // no local row quotes this order or payment
  | 'IGNORED'; // an event type this system does not act on

export async function applyRazorpayWebhook(
  db: PrismaClient,
  input: { eventId: string; parsed: ParsedWebhook; payload: Prisma.InputJsonValue },
): Promise<WebhookOutcome> {
  // A payout that landed also has to move the ledger, and that posting happens
  // AFTER the transaction below rather than inside it: `postTransaction` opens
  // a transaction of its own, and a Prisma transaction client cannot open one.
  // Collected here and posted afterwards, which is safe because the posting is
  // idempotent on a derived id — and because a crash in the gap leaves a PAID
  // payout with no settlement entry, which is precisely what the reconciliation
  // worker looks for.
  let applied: PayoutApplication;
  try {
    applied = await runPublishingTransaction(db, async (tx) => {
      if (input.parsed.kind === 'PAYOUT') {
        return applyPayoutEvent(tx, input.eventId, input.parsed, input.payload);
      }
      if (input.parsed.kind === 'IGNORED') {
        await recordEvent(tx, {
          eventId: input.eventId,
          eventType: input.parsed.eventType,
          eventTime: input.parsed.eventTime,
          outcome: 'IGNORED',
          payload: input.payload,
        });
        return { outcome: 'IGNORED', settlement: null };
      }
      const outcome = await applyPaymentEvent(tx, input.eventId, input.parsed, input.payload);
      return { outcome, settlement: null };
    });
  } catch (error) {
    // The unique index did its job: this delivery has been handled before, and
    // everything this attempt tried to write has been rolled back.
    if (isUniqueViolation(error)) return 'DUPLICATE';
    throw error;
  }

  if (applied.settlement) await settlePayoutOnLedger(db, applied.settlement);
  return applied.outcome;
}

type LedgerSettlement = { reference: string; technicianId: string; amountPaise: number };

// ---------------------------------------------------------------------------
// PAYMENTS.

async function applyPaymentEvent(
  tx: Prisma.TransactionClient,
  eventId: string,
  event: PaymentWebhook,
  payload: Prisma.InputJsonValue,
): Promise<WebhookOutcome> {
  const payment = await findLocalPayment(tx, event);
  if (!payment) {
    await recordEvent(tx, {
      eventId,
      eventType: event.eventType,
      eventTime: event.eventTime,
      outcome: 'UNMATCHED',
      payload,
    });
    logger.warn(
      { eventType: event.eventType, orderRef: event.orderRef, paymentRef: event.paymentRef },
      'a razorpay webhook named a payment this database does not have',
    );
    return 'UNMATCHED';
  }

  // A DECLINED CARD IS NOT A STATE CHANGE. The customer may try again on the
  // same order thirty seconds later, so recording FAILED on the payment row
  // would make a successful retry look like a recovery from a terminal state —
  // and would fight with the retry sweep, which is looking for exactly these
  // rows. It is written to the payment's own trail and nothing else moves.
  if (event.status === 'FAILED') {
    await recordPaymentEvent(tx, payment.id, 'GATEWAY_PAYMENT_FAILED', {
      paymentRef: event.paymentRef,
      eventType: event.eventType,
    });
    await recordEvent(tx, {
      eventId,
      eventType: event.eventType,
      eventTime: event.eventTime,
      outcome: 'APPLIED',
      paymentId: payment.id,
      payload,
    });
    return 'APPLIED';
  }

  if (!movesForward(payment.status, event.status)) {
    await recordEvent(tx, {
      eventId,
      eventType: event.eventType,
      eventTime: event.eventTime,
      outcome: 'OUT_OF_ORDER',
      paymentId: payment.id,
      payload,
    });
    return 'OUT_OF_ORDER';
  }

  await advancePaymentTo(tx, {
    paymentId: payment.id,
    jobId: payment.jobId,
    heldPaise: payment.amountPaise,
    to: event.status,
    paymentRef: event.paymentRef,
    amountPaise: event.amountPaise,
    eventType: event.eventType,
    source: 'webhook',
  });
  await recordEvent(tx, {
    eventId,
    eventType: event.eventType,
    eventTime: event.eventTime,
    outcome: 'APPLIED',
    paymentId: payment.id,
    payload,
  });
  return 'APPLIED';
}

// THREE WAYS TO FIND THE LOCAL ROW, tried in order of how much they prove.
// The order ref is what we stored when we opened the order; the payment ref is
// what we stored once it was authorised; the receipt is our own idempotency key
// coming back to us, and it is the only one that still works when the write
// that should have stored the order ref was lost.
async function findLocalPayment(tx: Prisma.TransactionClient, event: PaymentWebhook) {
  const select = { id: true, jobId: true, status: true, amountPaise: true } as const;

  if (event.orderRef) {
    const byOrder = await tx.payment.findFirst({ where: { gatewayOrderRef: event.orderRef }, select });
    if (byOrder) return byOrder;
  }
  if (event.paymentRef) {
    const byPayment = await tx.payment.findFirst({ where: { externalRef: event.paymentRef }, select });
    if (byPayment) return byPayment;
  }
  if (event.receipt) {
    const byReceipt = await tx.payment.findUnique({
      where: { idempotencyKey: event.receipt },
      select,
    });
    if (byReceipt) return byReceipt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PAYOUTS.

type PayoutApplication = { outcome: WebhookOutcome; settlement: LedgerSettlement | null };

async function applyPayoutEvent(
  tx: Prisma.TransactionClient,
  eventId: string,
  event: PayoutWebhook,
  payload: Prisma.InputJsonValue,
): Promise<PayoutApplication> {
  const payout = event.payoutRef
    ? await tx.payout.findFirst({
        where: { providerRef: event.payoutRef },
        select: { id: true, status: true, amountPaise: true, technicianId: true, batch: { select: { reference: true } } },
      })
    : null;

  if (!payout || !payout.batch) {
    await recordEvent(tx, {
      eventId,
      eventType: event.eventType,
      eventTime: event.eventTime,
      outcome: 'UNMATCHED',
      payload,
    });
    return { outcome: 'UNMATCHED', settlement: null };
  }

  if (event.status === 'IN_FLIGHT' || payout.status === 'PAID') {
    await recordEvent(tx, {
      eventId,
      eventType: event.eventType,
      eventTime: event.eventTime,
      outcome: 'OUT_OF_ORDER',
      payoutId: payout.id,
      payload,
    });
    return { outcome: 'OUT_OF_ORDER', settlement: null };
  }

  if (event.status === 'PROCESSED') {
    await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'PAID', failureReason: null },
    });
  } else {
    // FAILED or REVERSED. Back to PENDING with the reason on the row: the money
    // came back, the technician is still owed, and the next run sends it again.
    await tx.payout.update({
      where: { id: payout.id },
      data: { status: 'PENDING', providerRef: null, failureReason: event.eventType },
    });
  }

  await recordEvent(tx, {
    eventId,
    eventType: event.eventType,
    eventTime: event.eventTime,
    outcome: 'APPLIED',
    payoutId: payout.id,
    payload,
  });

  return {
    outcome: 'APPLIED',
    settlement:
      event.status === 'PROCESSED'
        ? {
            reference: payout.batch.reference,
            technicianId: payout.technicianId,
            amountPaise: payout.amountPaise,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------

async function recordEvent(
  tx: Prisma.TransactionClient,
  input: {
    eventId: string;
    eventType: string;
    eventTime: Date;
    outcome: WebhookOutcome;
    paymentId?: string;
    payoutId?: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.gatewayEvent.create({
    data: {
      provider: RAZORPAY,
      eventId: input.eventId,
      eventType: input.eventType,
      outcome: input.outcome,
      paymentId: input.paymentId ?? null,
      payoutId: input.payoutId ?? null,
      payload: input.payload,
      eventTime: input.eventTime,
    },
  });
}
