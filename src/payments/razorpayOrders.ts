// ORDERS, AND WHAT THE GATEWAY BELIEVES ABOUT THEM.
//
// Split out of the provider because it is a different concept. The provider
// implements four verbs the domain asks for; this file answers one question —
// "what does Razorpay currently think?" — and it has two callers with very
// different reasons for asking. The adapter asks so it can report an outcome.
// The RECONCILIATION WORKER asks because it is the only thing that can notice
// the gateway succeeded and our own write was lost.
//
// NOTHING HERE DECIDES ANYTHING. Every function returns a normalised
// `GatewayPaymentState` with no vendor field names in it, so the decision logic
// in src/payments/reconciliationDecision.ts can be a pure function over two
// plain values.

import {
  isRecord,
  razorpayCall,
  readNumber,
  readString,
} from './razorpayClient.js';
import type { GatewayPaymentState, GatewayPaymentStatus } from './gatewayState.js';

export type GatewayStateResult =
  | { outcome: 'OK'; state: GatewayPaymentState }
  | { outcome: 'UNREACHABLE'; reason: string };

export async function fetchPaymentState(paymentRef: string): Promise<GatewayStateResult> {
  const result = await razorpayCall({
    method: 'GET',
    path: `/v1/payments/${encodeURIComponent(paymentRef)}`,
  });
  if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
  if (result.outcome === 'REFUSED') {
    return { outcome: 'UNREACHABLE', reason: `${result.code}: ${result.description}` };
  }
  return { outcome: 'OK', state: paymentStateFrom(result.body) };
}

// THE FURTHEST-ALONG PAYMENT AGAINST AN ORDER. An order can collect several
// attempts — a declined card followed by a successful one — and what matters is
// the best outcome, not the most recent one.
export async function fetchOrderState(orderRef: string): Promise<GatewayStateResult> {
  const result = await razorpayCall({
    method: 'GET',
    path: `/v1/orders/${encodeURIComponent(orderRef)}/payments`,
  });
  if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
  if (result.outcome === 'REFUSED') {
    return { outcome: 'UNREACHABLE', reason: `${result.code}: ${result.description}` };
  }

  const items = Array.isArray(result.body.items) ? result.body.items : [];
  let best: GatewayPaymentState = {
    status: 'CREATED',
    paymentRef: null,
    orderRef,
    amountPaise: null,
    capturedPaise: null,
  };
  for (const item of items) {
    if (!isRecord(item)) continue;
    const candidate = paymentStateFrom(item);
    if (attemptRank(candidate.status) > attemptRank(best.status)) {
      best = { ...candidate, orderRef };
    }
  }
  return { outcome: 'OK', state: best };
}

// A LOCAL ORDERING, deliberately not the one in gatewayState.ts. That scale
// answers "did this payment move forward?" and puts FAILED off it entirely,
// because a decline is not a stage between authorised and captured. This one
// answers a different question — "which of these attempts tells me the most?" —
// and there a failed attempt beats no attempt at all. Two questions, two
// orderings, rather than one ordering bent to serve both.
function attemptRank(status: GatewayPaymentStatus): number {
  if (status === 'CREATED') return 0;
  if (status === 'FAILED') return 1;
  if (status === 'AUTHORISED') return 2;
  if (status === 'CAPTURED') return 3;
  return 4;
}

export function paymentStateFrom(entity: Record<string, unknown>): GatewayPaymentState {
  const raw = readString(entity, 'status') ?? 'created';
  const amountPaise = readNumber(entity, 'amount');
  const refundedPaise = readNumber(entity, 'amount_refunded') ?? 0;
  const status = statusFrom(raw, refundedPaise, amountPaise);

  return {
    status,
    paymentRef: readString(entity, 'id'),
    orderRef: readString(entity, 'order_id'),
    amountPaise,
    // Razorpay reports no separate captured figure: a captured payment's
    // `amount` IS what was taken.
    capturedPaise: status === 'CAPTURED' || status === 'REFUNDED' ? amountPaise : null,
  };
}

function statusFrom(
  raw: string,
  refundedPaise: number,
  amountPaise: number | null,
): GatewayPaymentStatus {
  if (raw === 'refunded') return 'REFUNDED';
  if (raw === 'captured') {
    // A partial refund leaves the payment `captured` with a non-zero
    // `amount_refunded`. Only a full one counts as REFUNDED, because the
    // question the rest of the system asks is "did we keep the money".
    if (amountPaise !== null && refundedPaise > 0 && refundedPaise >= amountPaise) return 'REFUNDED';
    return 'CAPTURED';
  }
  if (raw === 'authorized') return 'AUTHORISED';
  if (raw === 'failed') return 'FAILED';
  return 'CREATED';
}

// ---------------------------------------------------------------------------
// OPENING AN ORDER.
//
// THERE IS NO "FIND" HERE ANY MORE, and its absence is a measurement rather
// than an oversight. This file used to look an order up by `receipt` before
// creating one, because Razorpay accepts no idempotency header on order
// creation. Stage 2 ran it against the real API: `GET /v1/orders?receipt=X`
// returned count 0 immediately after an order was created with exactly that
// receipt, so a retry opened a second order. The receipt is still SENT — it is
// how a webhook is matched back when our own write was lost, and it is what a
// human sees in their dashboard — but nothing depends on being able to search
// by it. `knownOrderRef` (src/payments/provider.ts) is the mechanism now.

export type CreatedOrder =
  | { outcome: 'OK'; orderRef: string }
  | { outcome: 'REFUSED'; reason: string }
  | { outcome: 'UNREACHABLE'; reason: string };

export async function createOrder(input: {
  amountPaise: number;
  currency: string;
  receipt: string;
  jobId: string;
}): Promise<CreatedOrder> {
  const result = await razorpayCall({
    method: 'POST',
    path: '/v1/orders',
    body: {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      // MANUAL CAPTURE, and this flag is load-bearing. Zippy's two-stage split
      // — authorise the callout fee at dispatch, capture the approved total on
      // completion — depends on the customer's money being HELD rather than
      // taken. Auto-capture would charge the callout fee the moment they
      // finished checkout and leave nothing to capture later, quietly turning
      // every settlement rule in src/commit/payments.ts into fiction.
      //
      // STAGE 2 MUST CONFIRM THIS TAKES EFFECT. The account's own default can
      // override it, so the check is not "did the order get created" but "is
      // the payment `authorized` and not `captured` after a test checkout".
      payment_capture: false,
      notes: { zippyJobId: input.jobId, zippyKey: input.receipt },
    },
  });

  if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
  if (result.outcome === 'REFUSED') {
    return { outcome: 'REFUSED', reason: `${result.code}: ${result.description}` };
  }

  const orderRef = readString(result.body, 'id');
  if (!orderRef) return { outcome: 'UNREACHABLE', reason: 'an order response with no id' };
  return { outcome: 'OK', orderRef };
}
