// INVARIANT 8 — A STRANDED DRIVER DOES NOT WAIT FOR A CARD TO CLEAR.
//
//   "Authorisation failing or the provider being unreachable means the job
//    dispatches ANYWAY, payment state becomes PENDING_AUTHORISATION, the
//    operator sees it flagged, and a retry worker attempts it later."
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/money.test.ts. That suite proves
// the payment behaviour by calling `authoriseCallout` directly with a failing
// provider — which shows the payment ends up flagged, and shows nothing at all
// about dispatch, because nothing dispatched. The invariant is a claim about
// the DISPATCH PATH: that a reservation still commits with the gateway on
// fire. Proving it means driving the real route.
//
// So this drives `POST /technician/offers/:id/respond` — the endpoint a
// technician's phone actually calls to accept a job — with a provider
// installed that never answers, and asserts the saga committed, the unit was
// consumed, and the job is COMMITTED with a technician assigned. The payment
// being broken is the backdrop, not the subject.
//
// The provider is swapped through `setPaymentProvider`, the module-level seam
// in src/payments/stubProvider.ts, because the route calls
// `authoriseCalloutQuietly` and has no provider to pass. That seam exists for
// this test and the comment there says so.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { startSaga } from '../src/commit/saga.js';
import { authoriseCalloutQuietly } from '../src/commit/payments.js';
import { retryPendingAuthorisations } from '../src/commit/authorisationRetry.js';
import {
  FailingStubProvider,
  StubProvider,
  resetPaymentProvider,
  setPaymentProvider,
} from '../src/payments/stubProvider.js';
import type { PaymentProvider } from '../src/payments/provider.js';

const app = createApp();
const PREFIX = 'inv8';
const TENANT = `${PREFIX}-tenant`;
const PRICE_LIST = `${PREFIX}-list`;
// A window no other fixture uses — see the note in cancellation.test.ts. These
// jobs pin the list explicitly rather than resolving it, but the fixture still
// rebuilds the list, and rebuilding one another suite's job had pinned is how
// this bit.
const CREATED_AT = new Date('2016-06-01T00:00:00.000Z');
const CALLOUT_PAISE = 30000;

// A run-scoped id: each run builds its own saga, offer and job, because a saga
// is single-use and an offer can only be accepted once.
const RUN = Date.now().toString(36);
const TECH = `${PREFIX}-tech`;

function technicianToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-tech-user`,
    role: 'TECHNICIAN',
    tenantId: TENANT,
    crossTenant: false,
    actorId: TECH,
  });
}

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-dispatcher`,
    role: 'DISPATCHER',
    tenantId: null,
    crossTenant: true,
  });
}

// A provider that does not merely fail — it THROWS. A returned failure is the
// designed path; an exception is the undesigned one, and the invariant has to
// survive both.
class ExplodingProvider implements PaymentProvider {
  readonly name = 'exploding';
  async authorise(): Promise<never> {
    throw new Error('the gateway process died mid-request');
  }
  async capture(): Promise<never> {
    throw new Error('the gateway process died mid-request');
  }
  async voidAuthorisation(): Promise<never> {
    throw new Error('the gateway process died mid-request');
  }
}

beforeAll(async () => {
  await buildFixture();
});

afterEach(() => {
  // Never leave a broken provider installed for another suite.
  resetPaymentProvider();
});

afterAll(async () => {
  resetPaymentProvider();
  await prismaBase.$disconnect();
});

// One job, one unit, one saga with a live technician offer — the state a
// technician's phone is looking at when they tap Accept.
async function offerReadyToAccept(suffix: string): Promise<{ jobId: string; offerId: string }> {
  const jobId = `${PREFIX}-${RUN}-job-${suffix}`;
  const unitId = `${PREFIX}-${RUN}-unit-${suffix}`;

  await prismaBase.unit.create({
    data: {
      id: unitId,
      code: `${PREFIX}-${RUN}-${suffix}`,
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      lat: 12.94,
      lng: 77.62,
    },
  });
  await prismaBase.job.create({
    data: {
      id: jobId,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      priceListId: PRICE_LIST,
      settlementPath: 'WALK_IN',
      status: 'PLANNED',
      safetyLevel: 'NORMAL',
      createdAt: CREATED_AT,
      onHighway: false,
      lat: 12.9352,
      lng: 77.6245,
    },
  });

  const unit = await prismaBase.unit.findUniqueOrThrow({
    where: { id: unitId },
    select: { version: true },
  });
  const saga = await startSaga(prismaBase, {
    jobId,
    unitId,
    technicianId: TECH,
    expectedUnitVersion: unit.version,
    // No Redis in the fast suite: the expiry is a database race, not a broker
    // one, and offers.ts injects this seam for exactly that reason.
    scheduleExpiry: async () => {},
  });
  expect(saga.outcome).toBe('AWAITING_LEGS');

  const offer = await prismaBase.technicianOffer.findFirstOrThrow({
    where: { jobId, status: 'PROPOSED' },
    select: { id: true },
  });
  return { jobId, offerId: offer.id };
}

// ---------------------------------------------------------------------------

describe('the job dispatches even when the gateway is unreachable', () => {
  it('commits the reservation through the real accept route', async () => {
    setPaymentProvider(new FailingStubProvider('UNREACHABLE'));
    const { jobId, offerId } = await offerReadyToAccept('unreachable');

    const response = await request(app)
      .post(`/technician/offers/${offerId}/respond`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ decision: 'ACCEPTED' });

    // THE DISPATCH SUCCEEDED. Not a 5xx, not a degraded response — the
    // technician's phone gets the same answer it would on a good day.
    expect(response.status).toBe(200);
    expect(response.body.sagaState).toBe('COMMITTED');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, assignedTechnicianId: true, assignedUnitId: true },
    });
    expect(job.status).toBe('COMMITTED');
    expect(job.assignedTechnicianId).toBe(TECH);
    expect(job.assignedUnitId).not.toBeNull();

    // AND THE PAYMENT IS FLAGGED, not silently absent.
    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true, amountPaise: true },
    });
    expect(payment.status).toBe('PENDING_AUTHORISATION');
    expect(payment.amountPaise).toBe(CALLOUT_PAISE);
  });

  // A returned failure is the designed path. An exception is the undesigned
  // one, and a dispatch that survives only the failures somebody anticipated is
  // not the invariant.
  it('commits even when the provider throws', async () => {
    setPaymentProvider(new ExplodingProvider());
    const { jobId, offerId } = await offerReadyToAccept('exploding');

    const response = await request(app)
      .post(`/technician/offers/${offerId}/respond`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ decision: 'ACCEPTED' });

    expect(response.status).toBe(200);
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('COMMITTED');
  });

  it('never throws out of the dispatch path, whatever the provider does', async () => {
    setPaymentProvider(new ExplodingProvider());
    const { jobId } = await offerReadyToAccept('quiet');
    // The wrapper the dispatch path actually calls. If this can throw, every
    // caller of it is a way for a payment to fail a dispatch.
    await expect(authoriseCalloutQuietly(prismaBase, jobId)).resolves.toBeUndefined();
  });
});

describe('the operator sees it', () => {
  it('puts the failure on the incident timeline', async () => {
    const jobId = `${PREFIX}-${RUN}-job-unreachable`;

    // The same feed the dispatcher console renders (Phase 14).
    const response = await request(app)
      .get(`/events?jobId=${jobId}`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    const types = response.body.events.map((event: { eventType: string }) => event.eventType);
    expect(types).toContain('PAYMENT_AUTHORISATION_PENDING');

    // The reason travels with it, so an operator does not have to guess whether
    // the gateway declined or was simply unreachable.
    const flagged = response.body.events.find(
      (event: { eventType: string }) => event.eventType === 'PAYMENT_AUTHORISATION_PENDING',
    );
    expect(flagged.payload.reason).toBeTruthy();
  });

  it('leaves the payment findable by the sweep', async () => {
    const pending = await prismaBase.payment.count({
      where: { jobId: { startsWith: `${PREFIX}-${RUN}` }, status: 'PENDING_AUTHORISATION' },
    });
    expect(pending).toBeGreaterThanOrEqual(1);
  });
});

describe('a retry worker attempts it later', () => {
  it('recovers the authorisation once the gateway is back', async () => {
    const jobId = `${PREFIX}-${RUN}-job-unreachable`;

    // SCOPED TO THIS FILE'S JOBS. The sweep is global in production and global
    // in another suite that also calls it, so an unscoped call here races that
    // one for the same rows: whichever runs first authorises the other's
    // payment, and the loser asserts against a backlog somebody else cleared.
    const recovered = await retryPendingAuthorisations(prismaBase, {
      provider: new StubProvider(),
      jobIds: [jobId],
    });
    expect(recovered).toBeGreaterThanOrEqual(1);

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true, externalRef: true },
    });
    expect(payment.status).toBe('AUTHORISED');
    expect(payment.externalRef).toBeTruthy();

    // The job was never touched by any of it.
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('COMMITTED');
  });

  it('places one hold, not two, because the key is derived from the job', async () => {
    const jobId = `${PREFIX}-${RUN}-job-unreachable`;
    await retryPendingAuthorisations(prismaBase, { provider: new StubProvider(), jobIds: [jobId] });

    expect(await prismaBase.payment.count({ where: { jobId } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Invariant 8 Tenant', kind: 'CONSUMER' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'IN8',
      name: 'Invariant 8 Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'Invariant Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-driver-user`,
      email: `${PREFIX}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-driver-user`, tenantId: TENANT },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'KA01IN0001',
      colour: 'White',
    },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user`,
      email: `${PREFIX}-tech@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: 'Fixture Technician',
    },
  });
  await prismaBase.technician.upsert({
    where: { id: TECH },
    update: {},
    create: {
      id: TECH,
      userId: `${PREFIX}-tech-user`,
      employeeCode: `${PREFIX}-T1`,
      homeZoneId: `${PREFIX}-zone`,
    },
  });

  await prismaBase.job.updateMany({ where: { priceListId: PRICE_LIST }, data: { priceListId: null } });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Invariant 8 Fixture List',
      currency: 'INR',
      active: true,
      validFrom: new Date('2016-01-01T00:00:00.000Z'),
      validTo: new Date('2017-01-01T00:00:00.000Z'),
    },
  });
  await prismaBase.calloutFee.create({
    data: {
      priceListId: PRICE_LIST,
      serviceType: 'STANDARD',
      feePaise: CALLOUT_PAISE,
      validFrom: new Date('2016-01-01T00:00:00.000Z'),
    },
  });
}
