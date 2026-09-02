// ONE PLACE THAT MOVES A PAYMENT FORWARD, whoever brought the news.
//
// Two things learn that a payment advanced, and they must leave IDENTICAL
// trails: the webhook route (src/commit/razorpayWebhook.ts) and the
// reconciliation worker (src/commit/paymentReconciliation.ts). From the
// database's point of view there is no difference between "we captured it and
// recorded it", "we captured it, lost the write, and a webhook told us" and "we
// captured it, lost the write, no webhook arrived, and the sweep went and
// asked". If those three wrote different rows, every later read — the driver's
// screen, the ledger, an operator's timeline — would depend on which one
// happened to get there first.
//
// So the transition lives here once, and both callers hand it a transaction.
// It writes what the ordinary capture path in src/commit/payments.ts writes: the
// payment status, the authorisation or capture row, a payment event, and a job
// event so it is on the incident timeline (invariant 8).
//
// IT DOES NOT DECIDE ANYTHING. Whether a transition SHOULD happen is
// `movesForward` in src/payments/gatewayState.ts, checked by the callers. This
// function is told what state to reach and reaches it.

import type { Prisma } from '@prisma/client';
import type { GatewayPaymentStatus } from '../payments/gatewayState.js';
import { appendJobEvent } from '../intake/events.js';

// Gateway callbacks and our own attempts, in one append-only trail per payment.
export async function recordPaymentEvent(
  tx: Prisma.TransactionClient,
  paymentId: string,
  type: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  await tx.paymentEvent.create({ data: { paymentId, type, payload, eventTime: new Date() } });
}

// THE TRANSITION ITSELF, and it writes the rows a capture would have written if
// we had made it ourselves — because from the database's point of view there is
// no difference between "we captured and recorded it" and "we captured, lost
// the write, and learned about it from a webhook". The second must leave the
// same trail as the first or every later read is wrong.
export async function advancePaymentTo(
  tx: Prisma.TransactionClient,
  input: {
    paymentId: string;
    jobId: string;
    heldPaise: number;
    to: GatewayPaymentStatus;
    paymentRef: string | null;
    amountPaise: number | null;
    eventType: string;
    // WHICH OF THE THREE WAYS WE FOUND OUT. Written onto every row this makes,
    // because "a webhook told us" and "the sweep went and asked" are the same
    // transition and a very different story about what happened to the process
    // that should have recorded it in the first place.
    source: 'webhook' | 'reconciliation';
  },
): Promise<void> {
  const amountPaise = input.amountPaise ?? input.heldPaise;

  if (input.to === 'AUTHORISED') {
    await tx.payment.update({
      where: { id: input.paymentId },
      data: { status: 'AUTHORISED', externalRef: input.paymentRef },
    });
    await tx.authorisation.upsert({
      where: { paymentId: input.paymentId },
      update: { status: 'AUTHORISED', externalRef: input.paymentRef, authorisedAt: new Date() },
      create: {
        paymentId: input.paymentId,
        amountPaise,
        status: 'AUTHORISED',
        externalRef: input.paymentRef,
        authorisedAt: new Date(),
      },
    });
    await recordPaymentEvent(tx, input.paymentId, 'AUTHORISED', {
      source: input.source,
      externalRef: input.paymentRef,
      amountPaise,
    });
    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'CALLOUT_AUTHORISED',
      payload: { paymentId: input.paymentId, amountPaise, source: input.source },
    });
    return;
  }

  if (input.to === 'CAPTURED') {
    await tx.payment.update({
      where: { id: input.paymentId },
      data: { status: 'CAPTURED', amountPaise, externalRef: input.paymentRef },
    });
    // KEYED ON THE GATEWAY'S PAYMENT REF, not on the event id. A capture we
    // made ourselves and a webhook telling us about that same capture are one
    // event in the world and must be one row here; two events about one
    // Razorpay payment collide on this key and the second is skipped.
    await createCaptureIfNew(tx, {
      paymentId: input.paymentId,
      amountPaise,
      idempotencyKey: `gateway-${input.paymentRef ?? input.paymentId}`,
      externalRef: input.paymentRef,
    });
    await recordPaymentEvent(tx, input.paymentId, 'CAPTURED', {
      source: input.source,
      externalRef: input.paymentRef,
      amountPaise,
    });
    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'PAYMENT_CAPTURED',
      payload: { paymentId: input.paymentId, amountPaise, source: input.source },
    });
    return;
  }

  // REFUNDED.
  await tx.payment.update({ where: { id: input.paymentId }, data: { status: 'REFUNDED' } });
  await tx.refund.create({
    data: {
      paymentId: input.paymentId,
      amountPaise,
      reason: input.eventType,
      idempotencyKey: `gateway-refund-${input.paymentRef ?? input.paymentId}`,
      externalRef: input.paymentRef,
    },
  });
  await recordPaymentEvent(tx, input.paymentId, 'REFUNDED', {
    source: input.source,
    amountPaise,
  });
  await appendJobEvent(tx, {
    jobId: input.jobId,
    eventType: 'PAYMENT_REFUNDED',
    payload: { paymentId: input.paymentId, amountPaise, source: input.source },
  });
}

// A capture row we may already hold. The unique key is checked rather than
// caught, because this runs inside a transaction that also inserts the gateway
// event — and a caught constraint error would abort the whole transaction in
// Postgres regardless of what JavaScript did with it.
async function createCaptureIfNew(
  tx: Prisma.TransactionClient,
  input: { paymentId: string; amountPaise: number; idempotencyKey: string; externalRef: string | null },
): Promise<void> {
  const existing = await tx.capture.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing) return;
  await tx.capture.create({
    data: {
      paymentId: input.paymentId,
      amountPaise: input.amountPaise,
      idempotencyKey: input.idempotencyKey,
      externalRef: input.externalRef,
    },
  });
}
