// READING A WEBHOOK, AND NOTHING ELSE.
//
// A pure function from a JSON body to a plain value. No database, no network,
// no decisions — which is what lets the awkward cases (an event about a payment
// we have never heard of, an event type we do not handle, a "captured" arriving
// before an "authorised") be exercised in the fast suite as ordinary function
// calls.
//
// WHERE THE EVENT ID COMES FROM. Not the body: Razorpay puts it in the
// `x-razorpay-event-id` header, and that header is what makes a redelivery
// recognisable. The body of a redelivery is byte-identical to the original, so
// hashing the body would work too — but their id is the thing they themselves
// consider the delivery's identity, and a vendor's own id beats a hash we
// invented.
//
// EVENTS WE DO NOT HANDLE ARE NOT ERRORS. Razorpay lets you subscribe to
// several dozen event types and adds more over time; a subscription somebody
// widens in a dashboard must not start producing 500s here. An unhandled type
// parses to IGNORED, gets recorded, and gets a 200.

import { isRecord, readNumber, readString } from './razorpayClient.js';
import type { GatewayPaymentStatus } from './gatewayState.js';

export type PaymentWebhook = {
  kind: 'PAYMENT';
  eventType: string;
  eventTime: Date;
  // What this event says the payment has become.
  status: GatewayPaymentStatus;
  paymentRef: string | null;
  orderRef: string | null;
  amountPaise: number | null;
  // Our own idempotency key, echoed back as the order's receipt. The last
  // resort for matching an event to a local payment when the order ref never
  // reached our database.
  receipt: string | null;
};

export type PayoutWebhook = {
  kind: 'PAYOUT';
  eventType: string;
  eventTime: Date;
  payoutRef: string | null;
  // PROCESSED is money gone; FAILED and REVERSED both mean it came back and the
  // technician is still owed. IN_FLIGHT covers queued/pending/processing.
  status: 'PROCESSED' | 'FAILED' | 'REVERSED' | 'IN_FLIGHT';
  // The reference we sent with the payout, which is how it is matched back.
  reference: string | null;
};

export type IgnoredWebhook = { kind: 'IGNORED'; eventType: string; eventTime: Date };

export type ParsedWebhook = PaymentWebhook | PayoutWebhook | IgnoredWebhook;

export function parseWebhook(body: unknown): ParsedWebhook | null {
  if (!isRecord(body)) return null;
  const eventType = readString(body, 'event');
  if (!eventType) return null;

  // Razorpay sends seconds since the epoch; JavaScript wants milliseconds. A
  // missing timestamp falls back to now rather than to 1970, because an event
  // time in 1970 would sort a live event to the bottom of every operator view.
  const createdAt = readNumber(body, 'created_at');
  const eventTime = createdAt ? new Date(createdAt * 1000) : new Date();

  const payload = isRecord(body.payload) ? body.payload : {};
  const payment = entityOf(payload, 'payment');
  const order = entityOf(payload, 'order');
  const refund = entityOf(payload, 'refund');
  const payout = entityOf(payload, 'payout');

  if (eventType.startsWith('payout.')) {
    return {
      kind: 'PAYOUT',
      eventType,
      eventTime,
      payoutRef: payout ? readString(payout, 'id') : null,
      status: payoutStatusFor(eventType, payout),
      reference: payout ? readString(payout, 'reference_id') : null,
    };
  }

  const status = paymentStatusFor(eventType);
  if (!status) return { kind: 'IGNORED', eventType, eventTime };

  // A refund event carries the refund entity, and the payment it refunded is on
  // that entity rather than in a `payment` slot of its own.
  const paymentRef =
    (payment ? readString(payment, 'id') : null) ??
    (refund ? readString(refund, 'payment_id') : null);
  const orderRef =
    (payment ? readString(payment, 'order_id') : null) ?? (order ? readString(order, 'id') : null);

  return {
    kind: 'PAYMENT',
    eventType,
    eventTime,
    status,
    paymentRef,
    orderRef,
    amountPaise: payment ? readNumber(payment, 'amount') : null,
    receipt: order ? readString(order, 'receipt') : null,
  };
}

// THE ONLY MAPPING TABLE IN THIS FILE, and it is deliberately small. Every
// event type Zippy acts on, and what state it claims the payment has reached.
// `order.paid` maps to CAPTURED rather than to a state of its own: Razorpay
// fires it when an order is fully paid, which under manual capture means the
// money has been taken.
function paymentStatusFor(eventType: string): GatewayPaymentStatus | null {
  if (eventType === 'payment.authorized') return 'AUTHORISED';
  if (eventType === 'payment.captured') return 'CAPTURED';
  if (eventType === 'order.paid') return 'CAPTURED';
  if (eventType === 'payment.failed') return 'FAILED';
  if (eventType === 'refund.processed') return 'REFUNDED';
  return null;
}

function payoutStatusFor(
  eventType: string,
  payout: Record<string, unknown> | null,
): PayoutWebhook['status'] {
  if (eventType === 'payout.processed') return 'PROCESSED';
  if (eventType === 'payout.failed') return 'FAILED';
  if (eventType === 'payout.reversed') return 'REVERSED';
  // `payout.updated` carries the real state on the entity — it fires for every
  // hop through queued, pending and processing.
  const status = payout ? readString(payout, 'status') : null;
  if (status === 'processed') return 'PROCESSED';
  if (status === 'failed' || status === 'cancelled') return 'FAILED';
  if (status === 'reversed') return 'REVERSED';
  return 'IN_FLIGHT';
}

// Razorpay wraps every entity one level deep: payload.payment.entity. Reaching
// through it here keeps that shape out of the four call sites above.
function entityOf(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const slot = payload[key];
  if (!isRecord(slot)) return null;
  return isRecord(slot.entity) ? slot.entity : null;
}
