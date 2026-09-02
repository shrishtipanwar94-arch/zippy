// THE PAYMENT PROVIDER INTERFACE — the seam a real gateway arrives behind.
//
// Phase 22b swaps in Razorpay. Nothing else in this codebase changes when it
// does, and that is the entire purpose of this file: the settlement rules —
// when to authorise, what to capture, what a cancellation costs — are BUSINESS
// LOGIC, and business logic that can only be tested against a vendor sandbox is
// business logic nobody tests.
//
// THREE OPERATIONS, and a fourth that is optional. Authorise puts a hold on the
// customer's money; capture takes some or all of it; void releases it.
// Everything Zippy DECIDES is expressible in those three, and every extra
// required method here would be a method every future adapter has to implement.
//
// REFUND IS THE OPTIONAL FOURTH, added in Phase 22b, and it is optional because
// of a real difference between providers rather than to spare anyone work. The
// domain never asks for a refund: it asks to RELEASE money (a void). With the
// stub those are the same act. With Razorpay they are not — an authorised
// payment is released by letting it lapse, and a CAPTURED one can only be
// released by refunding it, so the adapter needs a refund to honour a void it
// receives too late. A provider that cannot refund is still a complete
// PaymentProvider, and `src/payments/stubProvider.ts` implements it anyway so
// the behaviour is testable without a vendor.
//
// WHAT PHASE 22b CHANGED HERE, and why it was the interface's fault rather
// than a rule's. Razorpay cannot place a hold synchronously: it opens an ORDER
// and the customer completes a checkout afterwards, which can be minutes
// later or never. The Phase 15c interface had no way to say that — the closest
// was UNREACHABLE, which means something quite different ("we never got an
// answer"). AWAITING_CUSTOMER below is that missing state. Every settlement
// rule is untouched: the commit path already treats every non-AUTHORISED
// outcome as a flagged PENDING_AUTHORISATION that dispatches the job anyway,
// and this outcome lands in the same branch.
//
// FAILURE IS A RETURN VALUE, NOT AN EXCEPTION, and the distinction between the
// two failure kinds is load-bearing:
//
//   DECLINED     the provider answered, and the answer was no. A retry will
//                get the same answer, so retrying is pointless.
//   UNREACHABLE  we never got an answer. The charge may or may not exist on
//                their side, which is why every request carries an idempotency
//                key — a retry with the same key is safe precisely because we
//                cannot know whether the first one landed.
//
// Collapsing those two into `throw` would lose the difference and make the
// retry sweep either useless or dangerous.
//
// IDEMPOTENCY KEYS ARE THE CALLER'S. The provider never mints one, because a
// key generated inside a retry is a new key on every attempt — the same rule
// the technician's offline queue follows (Phase 15).

import type { Paise } from '../domain/money.js';

export type AuthoriseRequest = {
  idempotencyKey: string;
  amountPaise: Paise;
  currency: string;
  // For the stub's audit line and, later, for a real gateway's metadata.
  reference: string;
  // WHAT WE ALREADY OPENED, when we have opened something. Phase 22b added
  // this, and it is invariant 1 applied to a vendor: Postgres is the source of
  // truth for what exists, not the gateway's search index.
  //
  // The adapter originally asked Razorpay "do you already have an order with
  // this receipt?" and Stage 2 measured the answer: their order list filtered
  // by receipt returns nothing, immediately after creating an order with that
  // exact receipt. So a retry opened a SECOND order. Our own row already knew
  // the answer — `payments.gateway_order_ref` is written the moment an order is
  // opened — and passing it in is both correct and one fewer round trip.
  //
  // Optional because the stub has no order concept and the FIRST call for any
  // job genuinely has nothing to pass.
  knownOrderRef?: string;
};

export type AuthoriseResult =
  | { outcome: 'AUTHORISED'; externalRef: string; expiresAt: Date }
  // The gateway has an order open and is waiting on the CUSTOMER. Nothing is
  // held, nobody has been charged, and the reference is an ORDER — the thing a
  // checkout screen needs — not an authorisation.
  | { outcome: 'AWAITING_CUSTOMER'; orderRef: string; reason: string }
  | { outcome: 'DECLINED'; reason: string }
  | { outcome: 'UNREACHABLE'; reason: string };

export type CaptureRequest = {
  idempotencyKey: string;
  authorisationRef: string;
  amountPaise: Paise;
};

export type CaptureResult =
  | { outcome: 'CAPTURED'; externalRef: string }
  | { outcome: 'DECLINED'; reason: string }
  | { outcome: 'UNREACHABLE'; reason: string };

export type VoidRequest = {
  idempotencyKey: string;
  authorisationRef: string;
};

export type VoidResult =
  | { outcome: 'VOIDED' }
  | { outcome: 'UNREACHABLE'; reason: string };

export type RefundRequest = {
  idempotencyKey: string;
  // The CAPTURED payment being refunded, not the authorisation.
  paymentRef: string;
  // Omitted means the whole thing. A gateway's own "full refund" is safer than
  // us telling it a figure we computed, because the figure it captured is the
  // figure it will refund.
  amountPaise?: Paise;
};

export type RefundResult =
  | { outcome: 'REFUNDED'; externalRef: string; amountPaise: Paise }
  | { outcome: 'DECLINED'; reason: string }
  | { outcome: 'UNREACHABLE'; reason: string };

export interface PaymentProvider {
  readonly name: string;
  authorise(request: AuthoriseRequest): Promise<AuthoriseResult>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
  voidAuthorisation(request: VoidRequest): Promise<VoidResult>;
  // Optional — see the note at the top of this file. Callers check for it and
  // report the provider cannot refund rather than assuming it can.
  refund?(request: RefundRequest): Promise<RefundResult>;
}
