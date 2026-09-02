// HOW FAR ALONG A PAYMENT IS, AS ONE ORDERED SCALE.
//
// Two different problems in this phase turn out to be the same question, and
// this file is the answer both of them use.
//
//   WEBHOOKS ARRIVE OUT OF ORDER. Razorpay fires `payment.authorized` and
//   `payment.captured` from different places and retries each independently, so
//   "captured" can land before "authorised" — and applying the older event
//   second would walk a payment BACKWARDS from captured to authorised.
//
//   RECONCILIATION COMPARES TWO OPINIONS. The worker asks the gateway what it
//   believes and holds that against what our database believes. "Are these the
//   same?" is easy; "which one is further along?" is what actually decides
//   whether we have work to do.
//
// So: every state a payment can be in gets a RANK, and every transition is only
// applied when it moves forward. That single rule handles duplicates (equal
// rank, ignore), out-of-order delivery (lower rank, ignore) and a lost write
// (gateway rank higher than ours, apply) without a special case for any of
// them.
//
// FAILED IS DELIBERATELY NOT ON THE SCALE. A failed payment attempt is not a
// stage between authorised and captured — the customer's card was declined and
// they may try again on the same order thirty seconds later. Ranking it would
// mean a decline permanently outranking the successful retry that followed it.
// It is handled as its own case by the callers, both of which say so.

import type { PaymentStatus } from '@prisma/client';

export type GatewayPaymentStatus =
  // The gateway has an order and nobody has paid against it yet.
  | 'CREATED'
  | 'AUTHORISED'
  | 'CAPTURED'
  | 'REFUNDED'
  | 'FAILED';

// What the gateway believes about one payment, normalised out of Razorpay's
// wire shapes so the decision logic never reads a vendor field name.
export type GatewayPaymentState = {
  status: GatewayPaymentStatus;
  // Razorpay's `pay_...`. Null while only an order exists.
  paymentRef: string | null;
  orderRef: string | null;
  amountPaise: number | null;
  capturedPaise: number | null;
};

const GATEWAY_RANK: Record<GatewayPaymentStatus, number> = {
  CREATED: 0,
  AUTHORISED: 1,
  CAPTURED: 2,
  REFUNDED: 3,
  // Off the scale — see the note above. Never compared, only matched on.
  FAILED: -1,
};

// Our own column, on the same scale, so the two can be held against each other.
// PENDING and PENDING_AUTHORISATION are both "nothing is held": they differ in
// whether we have TRIED, which matters to an operator and not to this ordering.
const LOCAL_RANK: Record<PaymentStatus, number> = {
  PENDING: 0,
  PENDING_AUTHORISATION: 0,
  AUTHORISED: 1,
  CAPTURED: 2,
  REFUNDED: 3,
  FAILED: -1,
};

export function gatewayRank(status: GatewayPaymentStatus): number {
  return GATEWAY_RANK[status];
}

export function localRank(status: PaymentStatus): number {
  return LOCAL_RANK[status];
}

// The one comparison both callers make. A transition is worth applying only
// when it moves the payment forward; equal or lower is a duplicate or a late
// delivery, and both mean "change nothing".
export function movesForward(from: PaymentStatus, to: GatewayPaymentStatus): boolean {
  const target = gatewayRank(to);
  if (target < 0) return false;
  return target > localRank(from);
}
