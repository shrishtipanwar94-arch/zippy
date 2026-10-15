// PHASE 22b — webhooks and reconciliation, against the real database.
//
// THE THREE CHECKS THE PHASE BRIEF NAMES, all provable without a gateway:
//
//   replay one webhook three times   -> one payment row, one transition
//   a bad signature                  -> rejected BEFORE anything is parsed
//   the app dies between the gateway
//   succeeding and the write landing -> the sweep settles it on the next pass
//
// The third is the interesting one and the reason this phase exists. It is
// simulated exactly: a payment row left in the state a crashed process would
// leave it — an order opened, nothing recorded — and a gateway that says the
// money was taken twenty minutes ago. No webhook is delivered at all. The sweep
// has to find it anyway.
//
// SCOPED TO THIS FILE'S OWN ROWS, throughout. `zippy_test` is shared and vitest
// runs files in parallel, so every assertion names a job this file created and
// every sweep is called with this file's ids — see the CLAUDE.md note about a
// globally side-effecting function being the same hazard as a raw count.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Prisma } from '@prisma/client';
import { prismaBase } from '../src/infra/prismaBase.js';
import { createApp } from '../src/api/app.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import { applyRazorpayWebhook, RAZORPAY } from '../src/commit/razorpayWebhook.js';
import { parseWebhook } from '../src/payments/razorpayEvents.js';
import { razorpayWebhookSignature } from '../src/payments/razorpaySignature.js';
import { reconcilePayments } from '../src/commit/paymentReconciliation.js';
import { resetRazorpayTransport, setRazorpayTransport } from '../src/payments/razorpayClient.js';
import type { RazorpayTransport } from '../src/payments/razorpayClient.js';

const PREFIX = 'rzw';
const RUN = Date.now().toString(36);
const TENANT = `${PREFIX}-tenant`;
const PRICE_LIST = `${PREFIX}-list`;

// DATED IN THE PAST. `GET /jobs` returns the fifty newest and two older suites
// assert their own jobs are in it, so a fixture that sorts to the top steals
// their slots — and a future-dated one steals them forever.
const CREATED_AT = new Date('2020-05-01T00:00:00.000Z');
const LIST_FROM = new Date('2020-01-01T00:00:00.000Z');
const LIST_TO = new Date('2021-01-01T00:00:00.000Z');
const CALLOUT_PAISE = 30000;

const app = createApp();

beforeAll(async () => {
  await buildFixture();
});

afterEach(() => {
  resetRazorpayTransport();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the webhook route rejects before it parses', () => {
  it('refuses a mis-signed body and writes nothing', async () => {
    const body = JSON.stringify(capturedEvent('order_nobody', 'pay_nobody'));

    const response = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', `${PREFIX}-${RUN}-badsig`)
      .set('x-razorpay-signature', razorpayWebhookSignature(Buffer.from(body), 'the-wrong-secret'))
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_signature');

    // NOTHING WAS RECORDED. A route that stored the event and then checked the
    // signature would let anybody who found the URL write rows.
    const stored = await prismaBase.gatewayEvent.findUnique({
      where: { provider_eventId: { provider: RAZORPAY, eventId: `${PREFIX}-${RUN}-badsig` } },
    });
    expect(stored).toBeNull();
  });

  it('refuses an unsigned body', async () => {
    const body = JSON.stringify(capturedEvent('order_nobody', 'pay_nobody'));

    const response = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', `${PREFIX}-${RUN}-nosig`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_signature');
  });

  // Their event id is the idempotency key, and it arrives in a header. A
  // delivery without one could not be recognised on a redelivery, so it is
  // refused rather than applied twice.
  it('refuses a correctly signed body with no event id', async () => {
    const body = JSON.stringify(capturedEvent('order_nobody', 'pay_nobody'));

    const response = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', razorpayWebhookSignature(Buffer.from(body), 'test-webhook-secret'))
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('missing_event_id');
  });

  // A VERIFIED DELIVERY ALWAYS GETS A 200, even one about a payment we cannot
  // match — Razorpay retries anything else, and this is not a failure to retry.
  it('accepts a verified event about a payment it cannot match', async () => {
    const body = JSON.stringify(capturedEvent('order_unknown', 'pay_unknown'));
    const eventId = `${PREFIX}-${RUN}-unmatched`;

    const response = await request(app)
      .post('/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', razorpayWebhookSignature(Buffer.from(body), 'test-webhook-secret'))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('UNMATCHED');

    // STORED AS EVIDENCE, not dropped. An event we cannot place is the exact
    // divergence the reconciliation worker exists to close.
    const stored = await prismaBase.gatewayEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: RAZORPAY, eventId } },
    });
    expect(stored.outcome).toBe('UNMATCHED');
  });
});

describe('a webhook replayed three times', () => {
  it('produces one transition, one capture row and one job event', async () => {
    const { jobId, paymentId } = await paymentAwaitingCustomer('replay');
    const eventId = `${PREFIX}-${RUN}-replay`;
    const event = capturedEvent(orderRefFor('replay'), paymentRefFor('replay'));

    const outcomes = [
      await deliver(eventId, event),
      await deliver(eventId, event),
      await deliver(eventId, event),
    ];

    // The first applied it; the second and third collided on the unique index
    // and rolled back whatever they had started to write.
    expect(outcomes).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE']);

    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true, amountPaise: true, externalRef: true },
    });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.externalRef).toBe(paymentRefFor('replay'));

    // ONE ROW EACH, and these are the assertions that would fail if idempotency
    // were a "have we seen this?" read rather than a constraint.
    const captures = await prismaBase.capture.count({ where: { paymentId } });
    expect(captures).toBe(1);

    const captured = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'PAYMENT_CAPTURED' },
    });
    expect(captured).toBe(1);

    const events = await prismaBase.gatewayEvent.count({
      where: { provider: RAZORPAY, eventId },
    });
    expect(events).toBe(1);
  });
});

describe('webhooks that arrive out of order', () => {
  // RAZORPAY FIRES THESE INDEPENDENTLY AND RETRIES THEM INDEPENDENTLY, so
  // captured-before-authorised is ordinary rather than exceptional.
  it('does not walk a captured payment back to authorised', async () => {
    const { paymentId } = await paymentAwaitingCustomer('ooo');

    const first = await deliver(
      `${PREFIX}-${RUN}-ooo-captured`,
      capturedEvent(orderRefFor('ooo'), paymentRefFor('ooo')),
    );
    const second = await deliver(
      `${PREFIX}-${RUN}-ooo-authorized`,
      authorizedEvent(orderRefFor('ooo'), paymentRefFor('ooo')),
    );

    expect(first).toBe('APPLIED');
    expect(second).toBe('OUT_OF_ORDER');

    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true },
    });
    expect(payment.status).toBe('CAPTURED');
  });

  // The late event is still RECORDED. "We ignored it" and "we never received
  // it" must not look the same to somebody reading the trail afterwards.
  it('records the late event with what it did about it', async () => {
    const stored = await prismaBase.gatewayEvent.findUniqueOrThrow({
      where: {
        provider_eventId: { provider: RAZORPAY, eventId: `${PREFIX}-${RUN}-ooo-authorized` },
      },
      select: { outcome: true, eventType: true },
    });
    expect(stored.outcome).toBe('OUT_OF_ORDER');
    expect(stored.eventType).toBe('payment.authorized');
  });

  // A DECLINED CARD IS NOT A STATE CHANGE. They may try again on the same order
  // in a minute, and a FAILED row would fight with the retry sweep.
  it('leaves a payment where it is when an attempt is declined', async () => {
    const { paymentId } = await paymentAwaitingCustomer('declined');

    const outcome = await deliver(`${PREFIX}-${RUN}-declined`, {
      event: 'payment.failed',
      created_at: 1_700_000_000,
      payload: {
        payment: {
          entity: {
            id: paymentRefFor('declined'),
            status: 'failed',
            amount: CALLOUT_PAISE,
            order_id: orderRefFor('declined'),
          },
        },
      },
    });

    expect(outcome).toBe('APPLIED');
    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true },
    });
    expect(payment.status).toBe('PENDING_AUTHORISATION');
  });
});

describe('reconciliation after a lost write', () => {
  // THE FAILURE THIS PHASE EXISTS TO HANDLE. The gateway captured the money and
  // the process died before recording it. No webhook is delivered here at all —
  // that is the point. Only asking closes it.
  it('settles a payment the gateway moved while the app was dead', async () => {
    const { jobId, paymentId } = await paymentAwaitingCustomer('lost');
    await ageForReconciliation(paymentId);

    setRazorpayTransport(
      transportSaying({
        [`GET /v1/orders/${orderRefFor('lost')}/payments`]: {
          items: [
            {
              id: paymentRefFor('lost'),
              status: 'captured',
              amount: CALLOUT_PAISE,
              order_id: orderRefFor('lost'),
            },
          ],
        },
      }),
    );

    const summary = await reconcilePayments(prismaBase, { jobIds: [jobId] });
    expect(summary.advanced).toBe(1);

    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true, externalRef: true },
    });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.externalRef).toBe(paymentRefFor('lost'));

    // THE SAME TRAIL A NORMAL CAPTURE LEAVES. A recovered capture that wrote
    // different rows would make every later read depend on how we found out.
    const captures = await prismaBase.capture.count({ where: { paymentId } });
    expect(captures).toBe(1);
    const jobEvents = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'PAYMENT_CAPTURED' },
    });
    expect(jobEvents).toBe(1);
  });

  // A SECOND PASS MUST DO NOTHING. The sweep runs every five minutes forever,
  // so "converges and then stops" is the property that matters.
  it('changes nothing on a second pass', async () => {
    const jobId = jobIdFor('lost');
    setRazorpayTransport(
      transportSaying({
        [`GET /v1/payments/${paymentRefFor('lost')}`]: {
          id: paymentRefFor('lost'),
          status: 'captured',
          amount: CALLOUT_PAISE,
          order_id: orderRefFor('lost'),
        },
      }),
    );

    const summary = await reconcilePayments(prismaBase, { jobIds: [jobId!] });
    expect(summary.advanced).toBe(0);

    const captures = await prismaBase.capture.count({
      where: { payment: { jobId: jobId! } },
    });
    expect(captures).toBe(1);
  });

  it('leaves a driver part-way through a checkout alone', async () => {
    const { jobId, paymentId } = await paymentAwaitingCustomer('waiting');
    await ageForReconciliation(paymentId);

    setRazorpayTransport(
      transportSaying({ [`GET /v1/orders/${orderRefFor('waiting')}/payments`]: { items: [] } }),
    );

    const summary = await reconcilePayments(prismaBase, { jobIds: [jobId] });
    expect(summary.awaitingCustomer).toBe(1);
    expect(summary.advanced).toBe(0);
  });

  // NEVER RESOLVED AUTOMATICALLY, because the resolution would be to
  // un-record a capture.
  it('escalates when the database claims money the gateway never took', async () => {
    const { jobId, paymentId } = await paymentAwaitingCustomer('ahead');
    await prismaBase.payment.update({
      where: { id: paymentId },
      data: { status: 'AUTHORISED', externalRef: paymentRefFor('ahead') },
    });
    await ageForReconciliation(paymentId);

    setRazorpayTransport(
      transportSaying({
        [`GET /v1/payments/${paymentRefFor('ahead')}`]: {
          id: paymentRefFor('ahead'),
          status: 'created',
          amount: CALLOUT_PAISE,
        },
      }),
    );

    const summary = await reconcilePayments(prismaBase, { jobIds: [jobId] });
    expect(summary.escalated).toBe(1);

    // The row is NOT corrected — an operator is told instead (invariant 8).
    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { status: true },
    });
    expect(payment.status).toBe('AUTHORISED');

    const flagged = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'PAYMENT_GATEWAY_DIVERGENCE' },
    });
    expect(flagged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FIXTURE.

const jobIds = new Map<string, string>();

function jobIdFor(name: string): string | undefined {
  return jobIds.get(name);
}

function orderRefFor(name: string): string {
  return `order_${PREFIX}_${RUN}_${name}`;
}

function paymentRefFor(name: string): string {
  return `pay_${PREFIX}_${RUN}_${name}`;
}

// A payment in exactly the state a real dispatch leaves behind when Razorpay
// has an order open and the driver has not paid: flagged
// PENDING_AUTHORISATION, order ref stored, job dispatched regardless.
async function paymentAwaitingCustomer(name: string): Promise<{ jobId: string; paymentId: string }> {
  const created = await createIntakeJob(prismaBase, {
    driverId: `${PREFIX}-driver`,
    vehicleId: `${PREFIX}-vehicle`,
    tenantId: TENANT,
    symptoms: {
      primaryComplaint: 'FLAT_TYRE',
      engineCranks: null,
      warningLights: [],
      unusualSound: null,
      vehicleMoves: null,
    },
    safety: {
      trafficSpeedKph: null,
      blockingLiveLane: false,
      smokeOrBurningSmell: false,
      fuelSmell: false,
      overheating: false,
      driverAlone: false,
      vulnerablePassengers: false,
    },
    location: {
      lat: 28.6152,
      lng: 77.2095,
      headingDegrees: null,
      accuracyMetres: null,
      nearestExit: null,
      kmMarker: null,
      landmark: null,
      roadPosition: 'PARKING',
      parkingLevel: null,
    },
    actor: null,
    at: CREATED_AT,
  });
  await prismaBase.job.update({
    where: { id: created.jobId },
    data: { priceListId: PRICE_LIST, createdAt: CREATED_AT },
  });

  const payment = await prismaBase.payment.create({
    data: {
      jobId: created.jobId,
      tenantId: TENANT,
      method: 'CARD',
      status: 'PENDING_AUTHORISATION',
      amountPaise: CALLOUT_PAISE,
      idempotencyKey: `auth-${created.jobId}`,
      gatewayOrderRef: orderRefFor(name),
    },
    select: { id: true },
  });

  jobIds.set(name, created.jobId);
  return { jobId: created.jobId, paymentId: payment.id };
}

// `updated_at` is managed by Prisma, so the only honest way to make a row look
// old is to say so in SQL. Scoped to one id — never a table-wide update.
async function ageForReconciliation(paymentId: string): Promise<void> {
  await prismaBase.$executeRaw`UPDATE payments SET updated_at = now() - interval '1 hour' WHERE id = ${paymentId}`;
}

async function deliver(eventId: string, event: Record<string, unknown>) {
  const parsed = parseWebhook(event);
  if (!parsed) throw new Error('the fixture built an event the parser does not recognise');
  // The same narrowing the route does: a JSON column takes Prisma's own
  // input type, and an event body is a plain object either way.
  return applyRazorpayWebhook(prismaBase, {
    eventId,
    parsed,
    payload: event as Prisma.InputJsonValue,
  });
}

function capturedEvent(orderRef: string, paymentRef: string): Record<string, unknown> {
  return {
    event: 'payment.captured',
    created_at: 1_700_000_000,
    payload: {
      payment: {
        entity: { id: paymentRef, status: 'captured', amount: CALLOUT_PAISE, order_id: orderRef },
      },
    },
  };
}

function authorizedEvent(orderRef: string, paymentRef: string): Record<string, unknown> {
  return {
    event: 'payment.authorized',
    created_at: 1_700_000_100,
    payload: {
      payment: {
        entity: { id: paymentRef, status: 'authorized', amount: CALLOUT_PAISE, order_id: orderRef },
      },
    },
  };
}

// A transport that answers a small table and refuses anything else, so a call
// this file did not expect fails loudly instead of reaching a network.
function transportSaying(routes: Record<string, unknown>): RazorpayTransport {
  return async (url, init) => {
    const key = `${init.method} ${url.replace('http://127.0.0.1:9', '')}`;
    const body = routes[key];
    if (body === undefined) throw new Error(`unexpected razorpay call: ${key}`);
    return { status: 200, text: JSON.stringify(body) };
  };
}

async function buildFixture(): Promise<void> {
  // Aged rather than deleted: `job_events` is append-only and enforced by a
  // trigger, so a job this file created can never be removed — only sorted out
  // of everybody's way.
  await prismaBase.job.updateMany({
    where: { driverId: `${PREFIX}-driver` },
    data: { createdAt: CREATED_AT },
  });

  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'RZW',
      name: 'Razorpay Webhook Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'Webhook Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  // A CONSUMER WITH NO CONTRACT — the one settlement path that uses a gateway.
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Razorpay Webhook Fixture', kind: 'CONSUMER' },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-user` },
    update: {},
    create: {
      id: `${PREFIX}-user`,
      email: `${PREFIX}@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Webhook Fixture Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-user`, tenantId: TENANT },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'DL01RZW1',
      colour: 'Grey',
    },
  });

  // This file owns its price list — deleted and rebuilt, the lesson an earlier
  // money suite learned the hard way.
  await prismaBase.job.updateMany({
    where: { priceListId: PRICE_LIST },
    data: { priceListId: null },
  });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Razorpay Webhook Fixture List',
      currency: 'INR',
      active: true,
      validFrom: LIST_FROM,
      validTo: LIST_TO,
    },
  });
  await prismaBase.calloutFee.create({
    data: {
      priceListId: PRICE_LIST,
      serviceType: 'STANDARD',
      feePaise: CALLOUT_PAISE,
      validFrom: LIST_FROM,
    },
  });
}
