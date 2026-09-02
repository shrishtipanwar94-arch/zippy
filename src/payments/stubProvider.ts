// THE TWO STUBS — one that always works, one that never does.
//
// NO NETWORK CALLS, NO API KEYS, NO SDK. Not "no real gateway yet" as a
// temporary state, but the deliberate arrangement that lets the settlement
// rules be exercised in the ordinary test suite: `npm run test:fast` proves
// what a cancellation costs and what happens when an authorisation fails,
// against no vendor and no sandbox, in milliseconds.
//
// It is also invariant 10's shape applied to money. Dispatch may not depend on
// an external service because a hosted API makes an evaluation run
// irreproducible; the same argument makes a vendor sandbox the wrong place to
// decide whether a customer who cancelled en route owes a callout fee.
//
// THE STUB REMEMBERS WHAT IT AUTHORISED, because the settlement rules need a
// provider that behaves like one: capturing more than was authorised has to be
// refusable, or the "second authorisation, never truncate" rule has nothing to
// push against. It is a Map, it lives for the life of the process, and it is
// not a database — a restart forgets, which is correct for a stand-in.

import { randomUUID } from 'node:crypto';
import type {
  AuthoriseRequest,
  AuthoriseResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  VoidRequest,
  VoidResult,
} from './provider.js';

// How long a stubbed hold lasts. Real gateways expire an authorisation in days
// and the exact number is a vendor's business, not ours; seven is a plausible
// figure and nothing depends on it yet.
const AUTHORISATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StubbedAuthorisation = {
  amountPaise: number;
  capturedPaise: number;
  refundedPaise: number;
  voided: boolean;
};

export class StubProvider implements PaymentProvider {
  readonly name = 'stub';

  private readonly authorisations = new Map<string, StubbedAuthorisation>();

  // IDEMPOTENCY IS THE STUB'S JOB TOO. A real gateway returns the original
  // result for a repeated key rather than charging twice, so a stub that
  // happily authorised twice would let a bug through that production would
  // catch.
  private readonly byIdempotencyKey = new Map<string, AuthoriseResult>();
  private readonly capturesByKey = new Map<string, CaptureResult>();

  async authorise(request: AuthoriseRequest): Promise<AuthoriseResult> {
    const seen = this.byIdempotencyKey.get(request.idempotencyKey);
    if (seen) return seen;

    const externalRef = `stub-auth-${randomUUID()}`;
    this.authorisations.set(externalRef, {
      amountPaise: request.amountPaise,
      capturedPaise: 0,
      refundedPaise: 0,
      voided: false,
    });

    const result: AuthoriseResult = {
      outcome: 'AUTHORISED',
      externalRef,
      expiresAt: new Date(Date.now() + AUTHORISATION_TTL_MS),
    };
    this.byIdempotencyKey.set(request.idempotencyKey, result);
    return result;
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const seen = this.capturesByKey.get(request.idempotencyKey);
    if (seen) return seen;

    const held = this.authorisations.get(request.authorisationRef);
    if (!held) return { outcome: 'DECLINED', reason: 'no such authorisation' };
    if (held.voided) return { outcome: 'DECLINED', reason: 'authorisation was voided' };

    // THE REFUSAL THAT MAKES THE RULE TESTABLE. A gateway will not let you take
    // more than you held, which is exactly why "capture the approved total; if
    // it exceeds the authorisation get a SECOND authorisation, never truncate"
    // is a rule at all.
    if (held.capturedPaise + request.amountPaise > held.amountPaise) {
      return { outcome: 'DECLINED', reason: 'capture exceeds the authorised amount' };
    }

    held.capturedPaise += request.amountPaise;
    const result: CaptureResult = { outcome: 'CAPTURED', externalRef: `stub-cap-${randomUUID()}` };
    this.capturesByKey.set(request.idempotencyKey, result);
    return result;
  }

  async voidAuthorisation(request: VoidRequest): Promise<VoidResult> {
    const held = this.authorisations.get(request.authorisationRef);
    // Voiding something that does not exist, or is already void, is a success.
    // A void is a release, and "it is not held" is the state a caller wanted.
    if (held) held.voided = true;
    return { outcome: 'VOIDED' };
  }

  // REFUND — giving back money already taken. Optional on the interface and
  // implemented here so the behaviour has a home in the fast suite: a refund
  // can only exceed nothing that was captured, and refunding twice with one
  // key gives the money back once.
  private readonly refundsByKey = new Map<string, RefundResult>();

  async refund(request: RefundRequest): Promise<RefundResult> {
    const seen = this.refundsByKey.get(request.idempotencyKey);
    if (seen) return seen;

    const held = this.authorisations.get(request.paymentRef);
    if (!held) return { outcome: 'DECLINED', reason: 'no such payment' };

    const refundable = held.capturedPaise - held.refundedPaise;
    const amountPaise = request.amountPaise ?? refundable;
    if (amountPaise <= 0 || amountPaise > refundable) {
      return { outcome: 'DECLINED', reason: 'refund exceeds what was captured' };
    }

    held.refundedPaise += amountPaise;
    const result: RefundResult = {
      outcome: 'REFUNDED',
      externalRef: `stub-ref-${randomUUID()}`,
      amountPaise,
    };
    this.refundsByKey.set(request.idempotencyKey, result);
    return result;
  }

  // Test affordance, not part of the interface: what the provider believes it
  // is still holding. Lets a test assert on the PROVIDER's view rather than
  // only on our own rows, which is the half that would catch us recording a
  // capture that never happened.
  heldAmount(externalRef: string): StubbedAuthorisation | undefined {
    return this.authorisations.get(externalRef);
  }
}

// ---------------------------------------------------------------------------

export type FailureMode = 'DECLINED' | 'UNREACHABLE';

// THE PROVIDER THAT NEVER WORKS. Its whole reason to exist is the rule that
// matters most in this phase: a stranded driver does not wait for a card to
// clear, so an authorisation failure must dispatch the job anyway. That
// behaviour is only provable against something that reliably fails.
//
// `failOn` narrows WHICH operation fails, because "authorisation is down" and
// "capture is down" are different incidents with different consequences — the
// first must not block a dispatch, the second must not lose a completed job's
// money.
export class FailingStubProvider implements PaymentProvider {
  readonly name = 'failing-stub';

  constructor(
    private readonly mode: FailureMode = 'UNREACHABLE',
    private readonly failOn: ReadonlySet<'authorise' | 'capture' | 'void'> = new Set([
      'authorise',
      'capture',
      'void',
    ]),
  ) {}

  private failure(): { outcome: 'DECLINED'; reason: string } | { outcome: 'UNREACHABLE'; reason: string } {
    return this.mode === 'DECLINED'
      ? { outcome: 'DECLINED', reason: 'the stub declines everything' }
      : { outcome: 'UNREACHABLE', reason: 'the stub is unreachable' };
  }

  async authorise(request: AuthoriseRequest): Promise<AuthoriseResult> {
    if (!this.failOn.has('authorise')) {
      return {
        outcome: 'AUTHORISED',
        externalRef: `failing-stub-auth-${request.idempotencyKey}`,
        expiresAt: new Date(Date.now() + AUTHORISATION_TTL_MS),
      };
    }
    return this.failure();
  }

  async capture(): Promise<CaptureResult> {
    if (!this.failOn.has('capture')) {
      return { outcome: 'CAPTURED', externalRef: 'failing-stub-cap' };
    }
    return this.failure();
  }

  async voidAuthorisation(): Promise<VoidResult> {
    if (!this.failOn.has('void')) return { outcome: 'VOIDED' };
    // A void has no DECLINED — a gateway that answers about a release either
    // released it or was not reached.
    return { outcome: 'UNREACHABLE', reason: 'the stub is unreachable' };
  }
}

// THE ONE THE APPLICATION USES. A module-level instance rather than a factory
// because there is exactly one provider per process and threading it through
// every call site would be dependency injection for its own sake — which the
// readability contract rules out.
export const stubProvider = new StubProvider();

// THE SEAM A ROUTE CANNOT REACH ANY OTHER WAY.
//
// Functions in src/commit/payments.ts take an optional provider, which is
// enough for a test that calls them directly. It is NOT enough for the claim
// invariant 8 actually makes — "the job dispatches even when the provider is
// down" — because that is a claim about the DISPATCH ROUTE, and the route
// calls `authoriseCalloutQuietly` with no provider to pass.
//
// So the active provider is swappable at the module level, the same shape
// `realtime/publish.ts` uses for its Socket.IO server. Production never calls
// the setter; a test installs a FailingStubProvider, drives the real route,
// and asserts the reservation still committed.
let active: PaymentProvider = stubProvider;

export function paymentProvider(): PaymentProvider {
  return active;
}

export function setPaymentProvider(provider: PaymentProvider): void {
  active = provider;
}

export function resetPaymentProvider(): void {
  active = stubProvider;
}
