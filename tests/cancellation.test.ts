// CANCELLATION — Phase 15c, the policy and what it settles.
//
// Its own file because it is its own concept: `src/domain/cancellationPolicy.ts`
// is the rule a CUSTOMER argues with, and a rule somebody argues with should be
// findable without reading a file about payment gateways. It is also what makes
// `npm run test:fast -- money ledger cancellation` — the phase brief's own
// command — select something.
//
// THE POLICY IS PURE and is tested as a pure function first: four stages, exact
// outcomes, no database. The second half then proves the settlement path acts
// on exactly what the policy said, including the case that needs a second
// authorisation because an on-scene cancellation costs more than the
// callout-only hold.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import {
  CANCELLATION_STAGES,
  cancellationCharge,
  cancellationStageFor,
} from '../src/domain/cancellationPolicy.js';
import { StubProvider } from '../src/payments/stubProvider.js';
import type {
  AuthoriseRequest,
  AuthoriseResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  VoidRequest,
  VoidResult,
} from '../src/payments/provider.js';
import { authoriseCallout, settleCancellation } from '../src/commit/payments.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import type { JobStatus } from '@prisma/client';

const PREFIX = 'cancel';
const FLEET = `${PREFIX}-fleet`;
const CONSUMER = `${PREFIX}-consumer`;
const WALKIN = `${PREFIX}-walkin`;
const PRICE_LIST = `${PREFIX}-list`;
// Past-dated for the same reason money.test.ts is: `GET /jobs` returns the 50
// newest, and two older suites assert their jobs are in it.
//
// AND IN A WINDOW NO OTHER FIXTURE USES. These jobs are created through real
// intake, which RESOLVES the price list in force at their creation instant —
// so two fixtures whose public lists overlap in time can each pin the other's
// list, and the next fixture to rebuild nulls a job it did not create. Every
// money-domain suite now owns a disjoint year: cancellation 2018, money 2020,
// ledger 2021, estimates 2022, coverage 2024, pricing 2030-31.
const CREATED_AT = new Date('2018-06-01T00:00:00.000Z');
const LIST_FROM = new Date('2018-01-01T00:00:00.000Z');
const LIST_TO = new Date('2019-01-01T00:00:00.000Z');

const CALLOUT_PAISE = 30000; // ₹300

// Records every call, so "a fleet job never touches a gateway" is asserted on
// the PROVIDER rather than on the absence of our own rows.
class RecordingProvider implements PaymentProvider {
  readonly name = 'recording';
  readonly calls: string[] = [];
  private readonly inner = new StubProvider();

  async authorise(request: AuthoriseRequest): Promise<AuthoriseResult> {
    this.calls.push('authorise');
    return this.inner.authorise(request);
  }
  async capture(request: CaptureRequest): Promise<CaptureResult> {
    this.calls.push('capture');
    return this.inner.capture(request);
  }
  async voidAuthorisation(request: VoidRequest): Promise<VoidResult> {
    this.calls.push('void');
    return this.inner.voidAuthorisation(request);
  }
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('what a cancellation costs', () => {
  const fee = 30000;
  const parts = 64000;

  it('takes nothing before a technician accepts', () => {
    expect(cancellationCharge({ stage: 'BEFORE_ACCEPTANCE', calloutFeePaise: fee, partsConsumedPaise: 0 }))
      .toMatchObject({ action: 'VOID', chargePaise: 0 });
  });

  // The row worth defending: an accept is not a cost. The van has not moved.
  it('takes nothing when they accepted but never set off', () => {
    expect(cancellationCharge({ stage: 'ACCEPTED_NOT_EN_ROUTE', calloutFeePaise: fee, partsConsumedPaise: 0 }))
      .toMatchObject({ action: 'VOID', chargePaise: 0 });
  });

  it('takes the callout fee once they are on the road', () => {
    const outcome = cancellationCharge({ stage: 'EN_ROUTE', calloutFeePaise: fee, partsConsumedPaise: 0 });
    expect(outcome).toMatchObject({ action: 'CAPTURE', chargePaise: fee, partsConsumedPaise: 0 });
  });

  it('takes the callout fee and the parts consumed once they have arrived', () => {
    const outcome = cancellationCharge({ stage: 'ON_SCENE', calloutFeePaise: fee, partsConsumedPaise: parts });
    expect(outcome).toMatchObject({ action: 'CAPTURE', chargePaise: fee + parts });
    // The components are on the outcome, so an invoice can say what the charge
    // was FOR rather than presenting one number to argue with.
    expect(outcome.calloutFeePaise).toBe(fee);
    expect(outcome.partsConsumedPaise).toBe(parts);
  });

  // Parts are charged when CONSUMED, never when merely carried.
  it('charges no parts for a van that arrived and opened nothing', () => {
    expect(cancellationCharge({ stage: 'ON_SCENE', calloutFeePaise: fee, partsConsumedPaise: 0 }).chargePaise)
      .toBe(fee);
  });

  it('answers for every stage', () => {
    for (const stage of CANCELLATION_STAGES) {
      const outcome = cancellationCharge({ stage, calloutFeePaise: fee, partsConsumedPaise: 0 });
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });

  it('maps a job status onto a commercial stage', () => {
    expect(cancellationStageFor('PLANNED')).toBe('BEFORE_ACCEPTANCE');
    expect(cancellationStageFor('COMMITTED')).toBe('ACCEPTED_NOT_EN_ROUTE');
    expect(cancellationStageFor('EN_ROUTE')).toBe('EN_ROUTE');
    expect(cancellationStageFor('ON_SITE')).toBe('ON_SCENE');
    // A paused job still has somebody standing next to the car.
    expect(cancellationStageFor('AWAITING_APPROVAL')).toBe('ON_SCENE');
    // Already finished: a policy answer would be a fiction.
    expect(cancellationStageFor('RESOLVED')).toBeNull();
    expect(cancellationStageFor('CANCELLED')).toBeNull();
  });
});

describe('cancelling settles per the policy', () => {
  it('voids the hold when the driver pulls out before the van moves', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new StubProvider();
    await authoriseCallout(prismaBase, { jobId, provider });

    const result = await settleCancellation(prismaBase, {
      jobId,
      statusAtCancellation: 'COMMITTED',
      provider,
    });
    expect(result).toMatchObject({ outcome: 'SETTLED', action: 'VOID', chargePaise: 0 });

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { amountPaise: true, externalRef: true },
    });
    expect(payment.amountPaise).toBe(0);
    // The PROVIDER agrees the hold is gone, not just our row.
    expect(provider.heldAmount(payment.externalRef ?? '')?.voided).toBe(true);
  });

  it('captures the callout fee when the technician was already on the road', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new StubProvider();
    await authoriseCallout(prismaBase, { jobId, provider });

    const result = await settleCancellation(prismaBase, {
      jobId,
      statusAtCancellation: 'EN_ROUTE',
      provider,
    });
    expect(result).toMatchObject({ outcome: 'SETTLED', action: 'CAPTURE', chargePaise: CALLOUT_PAISE });
  });

  // The interesting one: on scene costs MORE than the callout-only hold, so it
  // needs the second authorisation exactly as a completion does.
  it('captures the callout fee plus parts once they have arrived', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new StubProvider();
    await authoriseCallout(prismaBase, { jobId, provider });

    const partsConsumedPaise = 64000;
    const result = await settleCancellation(prismaBase, {
      jobId,
      statusAtCancellation: 'ON_SITE',
      partsConsumedPaise,
      provider,
    });
    expect(result).toMatchObject({
      outcome: 'SETTLED',
      action: 'CAPTURE',
      chargePaise: CALLOUT_PAISE + partsConsumedPaise,
    });
  });

  it('records the decision even when no gateway is involved', async () => {
    const { jobId } = await createJobFor(FLEET, 'fleet-vehicle');
    const provider = new RecordingProvider();

    const result = await settleCancellation(prismaBase, {
      jobId,
      statusAtCancellation: 'EN_ROUTE',
      provider,
    });
    expect(result.outcome).toBe('NO_GATEWAY');
    expect(provider.calls).toEqual([]);

    // A fleet job cancelled en route still owes a callout fee — it arrives on
    // next month's invoice rather than through a card, and the decision is on
    // the record either way.
    const event = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId, eventType: 'CANCELLATION_SETTLED' },
      select: { payload: true },
    });
    expect(event.payload).toMatchObject({ action: 'CAPTURE', chargePaise: CALLOUT_PAISE });
  });

  it('refuses to settle a job that was already finished', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const result = await settleCancellation(prismaBase, {
      jobId,
      statusAtCancellation: 'RESOLVED' as JobStatus,
      provider: new StubProvider(),
    });
    expect(result.outcome).toBe('NOT_CANCELLABLE');
  });
});

// ---------------------------------------------------------------------------

async function createJobFor(tenantId: string, vehicleSuffix: string) {
  const created = await createIntakeJob(prismaBase, {
    driverId: `${PREFIX}-${vehicleSuffix.replace('-vehicle', '')}-driver`,
    vehicleId: `${PREFIX}-${vehicleSuffix}`,
    tenantId,
    symptoms: { primaryComplaint: 'FLAT_TYRE', engineCranks: null, warningLights: [], unusualSound: null, vehicleMoves: null },
    safety: { trafficSpeedKph: null, blockingLiveLane: false, smokeOrBurningSmell: false, fuelSmell: false, overheating: false, driverAlone: false, vulnerablePassengers: false },
    location: { lat: 12.9352, lng: 77.6245, headingDegrees: null, accuracyMetres: null, nearestExit: null, kmMarker: null, landmark: null, roadPosition: 'PARKING', parkingLevel: null },
    actor: null,
    at: CREATED_AT,
  });

  // PINNED EXPLICITLY, not left to date resolution. Intake resolves whichever
  // public price list is in force at the job's creation instant, and this suite
  // is not about that — pricing.test.ts owns it. Relying on the resolution here
  // makes these tests depend on what every OTHER fixture's list window happens
  // to be, which is how a stale row from another suite once made a highway
  // callout unpriceable. Overriding costs one update and removes the coupling.
  await prismaBase.job.update({
    where: { id: created.jobId },
    data: { priceListId: PRICE_LIST },
  });
  return created;
}

// An approved estimate, written directly. Stage 2 owns the generation and the
// approval flow; what this stage needs is the RECORD OF CONSENT that a capture
// reads, so the fixture writes one rather than driving the whole loop.
async function approveEstimate(jobId: string, totalPaise: number): Promise<void> {
  await prismaBase.estimate.create({
    data: {
      jobId,
      priceListId: PRICE_LIST,
      status: 'APPROVED',
      subtotalPaise: totalPaise,
      totalPaise,
      lines: {
        create: [
          { kind: 'CALLOUT', description: 'Callout', quantity: 1, unitPricePaise: CALLOUT_PAISE, amountPaise: CALLOUT_PAISE },
          { kind: 'LABOUR', description: 'Labour', quantity: 1, unitPricePaise: totalPaise - CALLOUT_PAISE, amountPaise: totalPaise - CALLOUT_PAISE },
        ],
      },
    },
  });
}

async function buildFixture(): Promise<void> {
  // THIS FILE'S JOBS ARE AGED OUT, NOT DELETED — and the reason is a good one.
  //
  // Every test here creates a job through real intake, so a run leaves roughly
  // twenty behind and `zippy_test` keeps them. That matters beyond tidiness:
  // `GET /jobs` returns the 50 NEWEST jobs, and two older suites assert that a
  // dispatcher's list contains theirs, so an accumulating pile here pushes
  // them off the end.
  //
  // The obvious fix — delete them — is IMPOSSIBLE, and correctly so. Deleting
  // a job cascades to `job_events`, which is append-only and enforced by a
  // database trigger: "append-only table job_events: DELETE is not permitted".
  // The audit trail outranks a test's convenience, which is exactly the point
  // of putting that rule in the database rather than in a convention.
  //
  // So they are dated into the past instead. An old job is still there and
  // still auditable; it is simply never in the newest fifty.
  await prismaBase.job.updateMany({
    where: { driverId: { startsWith: PREFIX } },
    data: { createdAt: CREATED_AT },
  });

  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'CNL',
      name: 'Cancellation Zone',
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
      make: 'Cancellation Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.contractTier.upsert({
    where: { id: `${PREFIX}-tier` },
    update: {},
    create: { id: `${PREFIX}-tier`, name: 'GOLD', description: 'Cancellation fixture tier', priority: 30 },
  });

  // THREE TENANTS, ONE PER SETTLEMENT PATH.
  //   fleet     FLEET   + active contract          -> FLEET_TENANT
  //   consumer  CONSUMER + contract covering STANDARD -> CONTRACT_CONSUMER
  //   walkin    CONSUMER + no contract at all      -> WALK_IN
  const tenants: { id: string; kind: 'FLEET' | 'CONSUMER'; contract: boolean; covered: boolean }[] = [
    { id: FLEET, kind: 'FLEET', contract: true, covered: true },
    { id: CONSUMER, kind: 'CONSUMER', contract: true, covered: true },
    { id: WALKIN, kind: 'CONSUMER', contract: false, covered: false },
  ];

  for (const tenant of tenants) {
    await prismaBase.tenant.upsert({
      where: { id: tenant.id },
      update: {},
      create: { id: tenant.id, name: `Cancellation ${tenant.id}`, kind: tenant.kind },
    });

    if (tenant.contract) {
      await prismaBase.contract.upsert({
        where: { id: `${tenant.id}-contract` },
        // EVERY FIELD THIS FIXTURE CARES ABOUT, on the update as well as the
        // create. An `update` naming only what changed leaves the rest at
        // whatever an earlier version of this file wrote — which is exactly how
        // moving CREATED_AT left these contracts starting in 2030 and every
        // path resolving to WALK_IN. Third time this project has hit it.
        update: { active: true, startsAt: new Date('2017-01-01T00:00:00.000Z'), endsAt: null },
        create: {
          id: `${tenant.id}-contract`,
          tenantId: tenant.id,
          tierId: `${PREFIX}-tier`,
          name: `${tenant.id} contract`,
          // Before CREATED_AT, or no contract is active when the job is
          // raised and every path resolves to WALK_IN.
          startsAt: new Date('2017-01-01T00:00:00.000Z'),
          active: true,
        },
      });
      if (tenant.covered) {
        await prismaBase.coveredService.upsert({
          where: {
            contractId_serviceType: { contractId: `${tenant.id}-contract`, serviceType: 'STANDARD' },
          },
          update: { covered: true },
          create: {
            contractId: `${tenant.id}-contract`,
            serviceType: 'STANDARD',
            covered: true,
          },
        });
      }
    }

    const who = tenant.id.replace(`${PREFIX}-`, '');
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-${who}-user` },
      update: {},
      create: {
        id: `${PREFIX}-${who}-user`,
        email: `${PREFIX}-${who}@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: 'Fixture Driver',
      },
    });
    await prismaBase.driver.upsert({
      where: { id: `${PREFIX}-${who}-driver` },
      update: {},
      create: { id: `${PREFIX}-${who}-driver`, userId: `${PREFIX}-${who}-user`, tenantId: tenant.id },
    });
    await prismaBase.vehicle.upsert({
      where: { id: `${PREFIX}-${who}-vehicle` },
      update: {},
      create: {
        id: `${PREFIX}-${who}-vehicle`,
        driverId: `${PREFIX}-${who}-driver`,
        tenantId: tenant.id,
        profileId: `${PREFIX}-profile`,
        registration: `KA01CN${who.slice(0, 4).toUpperCase()}`,
        colour: 'Grey',
      },
    });
  }

  // This file owns its price list — deleted and rebuilt, the lesson stage 1
  // learned the hard way.
  await prismaBase.job.updateMany({
    where: { priceListId: PRICE_LIST },
    data: { priceListId: null },
  });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Cancellation Fixture List',
      currency: 'INR',
      active: true,
      // A window the seeded catalogue does not reach — it starts in 2026 — so
      // this list is the only one in force at CREATED_AT and nothing competes.
      validFrom: LIST_FROM,
      validTo: LIST_TO,
    },
  });
  await prismaBase.calloutFee.createMany({
    data: [
      { priceListId: PRICE_LIST, serviceType: 'STANDARD', feePaise: CALLOUT_PAISE, validFrom: LIST_FROM },
      { priceListId: PRICE_LIST, serviceType: 'HIGHWAY', feePaise: 50000, validFrom: LIST_FROM },
    ],
  });
  await prismaBase.labourRate.create({
    data: { priceListId: PRICE_LIST, code: 'STANDARD', ratePerHourPaise: 60000, validFrom: LIST_FROM },
  });
}
