// PHASE 22b — the Razorpay adapter, with no Razorpay.
//
// Everything in this file runs against a SCRIPTED TRANSPORT: a function that
// answers HTTP calls from a table instead of a network. Nothing here needs
// keys, a sandbox account or a working internet connection, which is the whole
// point — the awkward cases this integration exists to handle are exactly the
// ones a vendor sandbox will not produce on demand.
//
// WHAT IS PROVED HERE, in the order the phase brief asks for it:
//   a mis-signed webhook body fails verification, and an unsigned one too
//   a checkout handshake verifies against the key secret
//   an order is never opened twice for the same idempotency key
//   a second capture of an already-captured payment reads as success
//   a void against a CAPTURED payment becomes a refund
//   a webhook arriving out of order does not walk a payment backwards
//   the reconciliation decision table, case by case
//
// WHAT IS NOT PROVED HERE is that Razorpay's real responses look like the ones
// scripted below. That is Stage 2's job and it cannot be faked.

import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutSignature,
  razorpayWebhookSignature,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../src/payments/razorpaySignature.js';
import {
  resetRazorpayTransport,
  setRazorpayTransport,
  type RazorpayTransport,
} from '../src/payments/razorpayClient.js';
import { RazorpayProvider } from '../src/payments/razorpayProvider.js';
import { parseWebhook } from '../src/payments/razorpayEvents.js';
import { movesForward } from '../src/payments/gatewayState.js';
import { reconciliationDecisionFor } from '../src/payments/reconciliationDecision.js';
import { progressFrom } from '../src/payments/razorpayPayouts.js';

const WEBHOOK_SECRET = 'test-webhook-secret';
const KEY_SECRET = 'test-key-secret';

afterEach(() => {
  resetRazorpayTransport();
});

// A transport that answers from a table and REMEMBERS EVERY CALL. The record is
// what lets a test assert on what was NOT asked — "the order was looked up and
// not created again" is a claim about an absent call, and an assertion about
// our own return value cannot make it.
type Scripted = { status: number; body: unknown };

function scriptedTransport(routes: Record<string, Scripted | Scripted[]>) {
  const calls: string[] = [];
  const remaining = new Map<string, Scripted[]>();
  for (const [key, value] of Object.entries(routes)) {
    remaining.set(key, Array.isArray(value) ? [...value] : [value]);
  }

  const transport: RazorpayTransport = async (url, init) => {
    const path = url.replace('http://127.0.0.1:9', '');
    const key = `${init.method} ${path}`;
    calls.push(key);
    const queue = remaining.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`no scripted response for ${key}`);
    }
    // The LAST scripted response repeats, so a test only lists a sequence when
    // the sequence is the thing it is testing.
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { status: next.status, text: JSON.stringify(next.body) };
  };

  return { transport, calls };
}

describe('webhook signatures', () => {
  it('accepts a body signed with the webhook secret', () => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
    const signature = razorpayWebhookSignature(rawBody, WEBHOOK_SECRET);

    expect(verifyWebhookSignature({ rawBody, signature, secret: WEBHOOK_SECRET })).toBe(true);
  });

  it('rejects a body that was changed after signing', () => {
    const original = Buffer.from(JSON.stringify({ event: 'payment.captured', amount: 30000 }));
    const signature = razorpayWebhookSignature(original, WEBHOOK_SECRET);
    const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', amount: 3000000 }));

    expect(verifyWebhookSignature({ rawBody: tampered, signature, secret: WEBHOOK_SECRET })).toBe(
      false,
    );
  });

  it('rejects a signature made with the wrong secret', () => {
    const rawBody = Buffer.from('{}');
    const signature = razorpayWebhookSignature(rawBody, 'somebody-else-s-secret');

    expect(verifyWebhookSignature({ rawBody, signature, secret: WEBHOOK_SECRET })).toBe(false);
  });

  it('rejects an unsigned payload', () => {
    const rawBody = Buffer.from('{}');

    expect(verifyWebhookSignature({ rawBody, signature: undefined, secret: WEBHOOK_SECRET })).toBe(
      false,
    );
    expect(verifyWebhookSignature({ rawBody, signature: '', secret: WEBHOOK_SECRET })).toBe(false);
  });

  // A wrong-length signature must not reach `timingSafeEqual`, which throws on
  // mismatched buffers. Rejected, never thrown.
  it('rejects a signature of the wrong length without throwing', () => {
    const rawBody = Buffer.from('{}');

    expect(verifyWebhookSignature({ rawBody, signature: 'abc', secret: WEBHOOK_SECRET })).toBe(false);
  });

  // THE OTHER SIGNATURE, over a different message with a different secret.
  it('verifies the checkout handshake against the key secret', () => {
    const signature = checkoutSignature({
      orderRef: 'order_abc',
      paymentRef: 'pay_xyz',
      keySecret: KEY_SECRET,
    });

    expect(
      verifyCheckoutSignature({
        orderRef: 'order_abc',
        paymentRef: 'pay_xyz',
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
    // The same signature against a different payment is the replay this check
    // exists to catch.
    expect(
      verifyCheckoutSignature({
        orderRef: 'order_abc',
        paymentRef: 'pay_someone_else',
        signature,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
  });
});

describe('authorise, against an order', () => {
  it('opens one order and reports the customer has not paid yet', async () => {
    const { transport, calls } = scriptedTransport({
      'POST /v1/orders': { status: 200, body: { id: 'order_1' } },
      'GET /v1/orders/order_1/payments': { status: 200, body: { items: [] } },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().authorise({
      idempotencyKey: 'auth-job-1',
      amountPaise: 30000,
      currency: 'INR',
      reference: 'job-1',
    });

    expect(result.outcome).toBe('AWAITING_CUSTOMER');
    if (result.outcome === 'AWAITING_CUSTOMER') expect(result.orderRef).toBe('order_1');
    expect(calls).toContain('POST /v1/orders');
  });

  // THE ADAPTER'S IDEMPOTENCY FOR ORDERS, and it is our database rather than
  // the vendor. Razorpay accepts no idempotency header on order creation, and
  // Stage 2 measured their receipt filter returning nothing for an order that
  // had just been created with that receipt — so a retry that trusted the
  // lookup opened a SECOND order and gave one job two checkout screens.
  it('reuses the order reference it is given rather than opening a second one', async () => {
    const { transport, calls } = scriptedTransport({
      'GET /v1/orders/order_1/payments': { status: 200, body: { items: [] } },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().authorise({
      idempotencyKey: 'auth-job-1',
      amountPaise: 30000,
      currency: 'INR',
      reference: 'job-1',
      knownOrderRef: 'order_1',
    });

    expect(result.outcome).toBe('AWAITING_CUSTOMER');
    if (result.outcome === 'AWAITING_CUSTOMER') expect(result.orderRef).toBe('order_1');
    // The claim is about a call that must NOT happen.
    expect(calls).not.toContain('POST /v1/orders');
  });

  // THE RETRY SWEEP DOUBLING AS A RECONCILER. The driver paid while nothing was
  // watching; asking again is how we find out.
  it('reports AUTHORISED once a payment exists against the order', async () => {
    const { transport } = scriptedTransport({
      'GET /v1/orders/order_1/payments': {
        status: 200,
        body: { items: [{ id: 'pay_1', status: 'authorized', amount: 30000, order_id: 'order_1' }] },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().authorise({
      idempotencyKey: 'auth-job-1',
      amountPaise: 30000,
      currency: 'INR',
      reference: 'job-1',
      knownOrderRef: 'order_1',
    });

    expect(result.outcome).toBe('AUTHORISED');
    if (result.outcome === 'AUTHORISED') expect(result.externalRef).toBe('pay_1');
  });

  it('prefers the successful attempt over an earlier declined one', async () => {
    const { transport } = scriptedTransport({
      'GET /v1/orders/order_1/payments': {
        status: 200,
        body: {
          items: [
            { id: 'pay_declined', status: 'failed', amount: 30000 },
            { id: 'pay_good', status: 'authorized', amount: 30000 },
          ],
        },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().authorise({
      idempotencyKey: 'auth-job-1',
      amountPaise: 30000,
      currency: 'INR',
      reference: 'job-1',
      knownOrderRef: 'order_1',
    });

    expect(result.outcome).toBe('AUTHORISED');
    if (result.outcome === 'AUTHORISED') expect(result.externalRef).toBe('pay_good');
  });

  // A 5xx is not an answer. The distinction matters because UNREACHABLE is
  // retried and DECLINED is not.
  it('reports a server error as unreachable rather than declined', async () => {
    const { transport } = scriptedTransport({
      'POST /v1/orders': {
        status: 500,
        body: { error: { code: 'SERVER_ERROR', description: 'we are having a moment' } },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().authorise({
      idempotencyKey: 'auth-job-1',
      amountPaise: 30000,
      currency: 'INR',
      reference: 'job-1',
    });

    expect(result.outcome).toBe('UNREACHABLE');
  });
});

describe('capture and void', () => {
  it('treats an already-captured payment as captured', async () => {
    const { transport } = scriptedTransport({
      'POST /v1/payments/pay_1/capture': {
        status: 400,
        body: {
          error: { code: 'BAD_REQUEST_ERROR', description: 'This payment has already been captured' },
        },
      },
      'GET /v1/payments/pay_1': {
        status: 200,
        body: { id: 'pay_1', status: 'captured', amount: 30000 },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().capture({
      idempotencyKey: 'complete-cap-job-1',
      authorisationRef: 'pay_1',
      amountPaise: 30000,
    });

    expect(result.outcome).toBe('CAPTURED');
  });

  it('reports a genuine refusal as declined', async () => {
    const { transport } = scriptedTransport({
      'POST /v1/payments/pay_1/capture': {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount is invalid' } },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().capture({
      idempotencyKey: 'complete-cap-job-1',
      authorisationRef: 'pay_1',
      amountPaise: 30000,
    });

    expect(result.outcome).toBe('DECLINED');
  });

  // THE REASON `refund` IS ON THE INTERFACE AT ALL. Razorpay has no void
  // endpoint, and a captured payment can only be released by refunding it. The
  // domain asked to release money and is answered VOIDED either way — no
  // business rule knows this happened.
  it('refunds a captured payment when asked to void it', async () => {
    const { transport, calls } = scriptedTransport({
      'GET /v1/payments/pay_1': {
        status: 200,
        body: { id: 'pay_1', status: 'captured', amount: 30000 },
      },
      'POST /v1/payments/pay_1/refund': { status: 200, body: { id: 'rfnd_1', amount: 30000 } },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().voidAuthorisation({
      idempotencyKey: 'void-job-1',
      authorisationRef: 'pay_1',
    });

    expect(result.outcome).toBe('VOIDED');
    expect(calls).toContain('POST /v1/payments/pay_1/refund');
  });

  it('leaves an uncaptured authorisation to lapse without calling anything', async () => {
    const { transport, calls } = scriptedTransport({
      'GET /v1/payments/pay_1': {
        status: 200,
        body: { id: 'pay_1', status: 'authorized', amount: 30000 },
      },
    });
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().voidAuthorisation({
      idempotencyKey: 'void-job-1',
      authorisationRef: 'pay_1',
    });

    expect(result.outcome).toBe('VOIDED');
    expect(calls).not.toContain('POST /v1/payments/pay_1/refund');
  });

  // Voiding a job whose customer never completed checkout: there is only an
  // order, so there is nothing to release and nothing to ask.
  it('voids an order reference without calling the gateway', async () => {
    const { transport, calls } = scriptedTransport({});
    setRazorpayTransport(transport);

    const result = await new RazorpayProvider().voidAuthorisation({
      idempotencyKey: 'void-job-1',
      authorisationRef: 'order_1',
    });

    expect(result.outcome).toBe('VOIDED');
    expect(calls).toEqual([]);
  });
});

describe('reading a webhook', () => {
  it('reads a captured payment out of the envelope', () => {
    const parsed = parseWebhook({
      event: 'payment.captured',
      created_at: 1_700_000_000,
      payload: {
        payment: { entity: { id: 'pay_1', status: 'captured', amount: 30000, order_id: 'order_1' } },
      },
    });

    expect(parsed?.kind).toBe('PAYMENT');
    if (parsed?.kind !== 'PAYMENT') return;
    expect(parsed.status).toBe('CAPTURED');
    expect(parsed.paymentRef).toBe('pay_1');
    expect(parsed.orderRef).toBe('order_1');
    expect(parsed.amountPaise).toBe(30000);
  });

  it('finds our own idempotency key on the order receipt', () => {
    const parsed = parseWebhook({
      event: 'order.paid',
      created_at: 1_700_000_000,
      payload: {
        order: { entity: { id: 'order_1', receipt: 'auth-job-1' } },
        payment: { entity: { id: 'pay_1', status: 'captured', amount: 30000 } },
      },
    });

    expect(parsed?.kind).toBe('PAYMENT');
    if (parsed?.kind !== 'PAYMENT') return;
    expect(parsed.receipt).toBe('auth-job-1');
  });

  // A subscription somebody widens in a dashboard must not start producing
  // 500s here.
  it('ignores an event type this system does not act on', () => {
    const parsed = parseWebhook({ event: 'subscription.charged', created_at: 1, payload: {} });

    expect(parsed?.kind).toBe('IGNORED');
  });

  it('refuses a body that is not an event at all', () => {
    expect(parseWebhook({ hello: 'world' })).toBeNull();
    expect(parseWebhook('a string')).toBeNull();
  });

  it('reads a payout event and its reference', () => {
    const parsed = parseWebhook({
      event: 'payout.processed',
      created_at: 1_700_000_000,
      payload: {
        payout: { entity: { id: 'pout_1', status: 'processed', reference_id: 'payout:x:tech-1' } },
      },
    });

    expect(parsed?.kind).toBe('PAYOUT');
    if (parsed?.kind !== 'PAYOUT') return;
    expect(parsed.status).toBe('PROCESSED');
    expect(parsed.payoutRef).toBe('pout_1');
  });
});

describe('ordering', () => {
  // THE OUT-OF-ORDER RULE, as a table. `payment.captured` before
  // `payment.authorized` is ordinary Razorpay behaviour, and the late
  // `authorized` must change nothing.
  it('only ever moves a payment forward', () => {
    expect(movesForward('PENDING', 'AUTHORISED')).toBe(true);
    expect(movesForward('PENDING_AUTHORISATION', 'CAPTURED')).toBe(true);
    expect(movesForward('AUTHORISED', 'CAPTURED')).toBe(true);
    expect(movesForward('CAPTURED', 'REFUNDED')).toBe(true);

    // The late arrivals.
    expect(movesForward('CAPTURED', 'AUTHORISED')).toBe(false);
    expect(movesForward('CAPTURED', 'CAPTURED')).toBe(false);
    expect(movesForward('REFUNDED', 'CAPTURED')).toBe(false);

    // A decline is never a stage. It is off the scale in both directions.
    expect(movesForward('PENDING', 'FAILED')).toBe(false);
    expect(movesForward('FAILED', 'CAPTURED')).toBe(true);
  });
});

describe('the reconciliation decision', () => {
  const gateway = (status: 'CREATED' | 'AUTHORISED' | 'CAPTURED' | 'REFUNDED' | 'FAILED') => ({
    status,
    paymentRef: status === 'CREATED' ? null : 'pay_1',
    orderRef: 'order_1',
    amountPaise: 30000,
    capturedPaise: status === 'CAPTURED' ? 30000 : null,
  });

  // THE CASE THE WHOLE PHASE EXISTS FOR: the gateway took the money and our
  // write was lost.
  it('advances a payment the gateway has moved and the database has not', () => {
    const decision = reconciliationDecisionFor({
      local: 'PENDING_AUTHORISATION',
      gateway: gateway('CAPTURED'),
    });

    expect(decision.action).toBe('ADVANCE');
    if (decision.action === 'ADVANCE') expect(decision.to).toBe('CAPTURED');
  });

  it('does nothing when the two agree', () => {
    expect(reconciliationDecisionFor({ local: 'CAPTURED', gateway: gateway('CAPTURED') }).action).toBe(
      'NOTHING',
    );
  });

  it('leaves a driver part-way through a checkout alone', () => {
    expect(reconciliationDecisionFor({ local: 'PENDING', gateway: gateway('CREATED') }).action).toBe(
      'AWAIT_CUSTOMER',
    );
  });

  it('does nothing about a declined attempt, because they may try again', () => {
    expect(
      reconciliationDecisionFor({ local: 'PENDING_AUTHORISATION', gateway: gateway('FAILED') }).action,
    ).toBe('NOTHING');
  });

  // NEVER RESOLVED AUTOMATICALLY. Correcting this would mean un-recording a
  // capture, and a system that can quietly do that is worse than one that
  // occasionally needs a human.
  it('escalates when the database claims money the gateway never took', () => {
    expect(
      reconciliationDecisionFor({ local: 'CAPTURED', gateway: gateway('AUTHORISED') }).action,
    ).toBe('ESCALATE');
    expect(reconciliationDecisionFor({ local: 'AUTHORISED', gateway: gateway('CREATED') }).action).toBe(
      'ESCALATE',
    );
  });
});

describe('payout status mapping', () => {
  // AN UNKNOWN STATUS IS NEVER "SENT". RazorpayX can add a status tomorrow, and
  // the safe reading of one we do not recognise is that the money has not
  // landed yet.
  it('treats anything but processed and failed as still in flight', () => {
    expect(progressFrom('processed')).toBe('PROCESSED');
    expect(progressFrom('failed')).toBe('FAILED');
    expect(progressFrom('reversed')).toBe('FAILED');
    expect(progressFrom('cancelled')).toBe('FAILED');
    expect(progressFrom('queued')).toBe('IN_FLIGHT');
    expect(progressFrom('processing')).toBe('IN_FLIGHT');
    expect(progressFrom('something_new')).toBe('IN_FLIGHT');
    expect(progressFrom(null)).toBe('IN_FLIGHT');
  });
});
