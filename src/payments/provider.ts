// THE PAYMENT PROVIDER INTERFACE — the seam a real gateway arrives behind.
//
// Phase 22b swaps in Razorpay. Nothing else in this codebase changes when it
// does, and that is the entire purpose of this file: the settlement rules —
// when to authorise, what to capture, what a cancellation costs — are BUSINESS
// LOGIC, and business logic that can only be tested against a vendor sandbox is
// business logic nobody tests.
//
// THREE OPERATIONS, and no more. Authorise puts a hold on the customer's money;
// capture takes some or all of it; void releases it. Everything Zippy needs is
// expressible in those three, and every extra method here would be a method a
// future adapter has to implement.
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
};

export type AuthoriseResult =
  | { outcome: 'AUTHORISED'; externalRef: string; expiresAt: Date }
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

export interface PaymentProvider {
  readonly name: string;
  authorise(request: AuthoriseRequest): Promise<AuthoriseResult>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
  voidAuthorisation(request: VoidRequest): Promise<VoidResult>;
}
