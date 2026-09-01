// PAYMENT — Phase 15c stage 3.
//
// The brief's own check list for this stage, and where each is proved:
//
//   each of the three settlement paths resolves correctly from the contract
//   capture exceeding the authorisation -> second authorisation, not truncation
//   partial capture -> remainder voided
//   cancel at each of the four stages -> the policy function's exact outcome
//   provider unreachable at commit -> job dispatches, payment PENDING, flagged
//   double capture with the same idempotency key -> captured once
//   a GOLD fleet job never calls the provider at all
//
// THE LAST ONE IS ASSERTED ON THE PROVIDER, not on our own rows. A test that
// only checks "no payment row was written" would pass even if we had called a
// gateway and thrown the answer away, so the fleet test uses a provider that
// records every call and asserts the recording is empty.
//
// NO NETWORK ANYWHERE. That is the point of the stub, and it is why settlement
// rules — what a cancellation costs, what happens when a gateway is down — run
// in the ordinary fast suite in milliseconds rather than against a vendor
// sandbox.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import {
  CANCELLATION_STAGES,
  cancellationCharge,
  cancellationStageFor,
} from '../src/domain/cancellationPolicy.js';
import { resolveSettlementPath, usesGateway } from '../src/domain/settlementPath.js';
import { StubProvider, FailingStubProvider } from '../src/payments/stubProvider.js';
import type {
  AuthoriseRequest,
  AuthoriseResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  VoidRequest,
  VoidResult,
} from '../src/payments/provider.js';
import { authoriseCallout, captureOnCompletion, settleCancellation } from '../src/commit/payments.js';
import { retryPendingAuthorisations } from '../src/commit/authorisationRetry.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import type { JobStatus } from '@prisma/client';

const PREFIX = 'pay';
const FLEET = `${PREFIX}-fleet`;
const CONSUMER = `${PREFIX}-consumer`;
const WALKIN = `${PREFIX}-walkin`;
const PRICE_LIST = `${PREFIX}-list`;
// DATED IN THE PAST, and this is not arbitrary. `GET /jobs` returns the 50
// newest jobs, and two older suites (ownership, tenancy) assert that a
// dispatcher's list contains the jobs they created. This file creates roughly
// twenty, so future-dating them pushed those suites' jobs off the end of the
// list and broke them. Sorting to the BOTTOM keeps this fixture out of
// everybody's way. The price list below is dated to match, in a window the
// seeded catalogue does not reach.
const CREATED_AT = new Date('2020-06-01T00:00:00.000Z');
const LIST_FROM = new Date('2020-01-01T00:00:00.000Z');
const LIST_TO = new Date('2021-01-01T00:00:00.000Z');

const CALLOUT_PAISE = 30000; // ₹300

// A provider that does everything the stub does and REMEMBERS BEING ASKED.
// The only way to prove a fleet job never touches a gateway.
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

describe('which of the three ways a job settles', () => {
  it('sends a contracted fleet to monthly invoicing whatever the cover says', () => {
    // An uncovered service on a fleet contract is an invoice line argued about
    // at month end — not a moment to ask a stranded fleet driver for a card.
    expect(resolveSettlementPath({ tenantKind: 'FLEET', hasActiveContract: true, serviceCovered: false }))
      .toBe('FLEET_TENANT');
  });

  it('gives a covered consumer a zero-payable path', () => {
    expect(resolveSettlementPath({ tenantKind: 'CONSUMER', hasActiveContract: true, serviceCovered: true }))
      .toBe('CONTRACT_CONSUMER');
  });

  it('treats a consumer whose contract does not cover this service as a walk-in', () => {
    expect(resolveSettlementPath({ tenantKind: 'CONSUMER', hasActiveContract: true, serviceCovered: false }))
      .toBe('WALK_IN');
  });

  it('treats a fleet with no active contract as a walk-in', () => {
    expect(resolveSettlementPath({ tenantKind: 'FLEET', hasActiveContract: false, serviceCovered: false }))
      .toBe('WALK_IN');
  });

  it('only ever calls a gateway on the walk-in path', () => {
    expect(usesGateway('WALK_IN')).toBe(true);
    expect(usesGateway('FLEET_TENANT')).toBe(false);
    expect(usesGateway('CONTRACT_CONSUMER')).toBe(false);
  });
});

describe('the stub provider behaves like a gateway', () => {
  it('returns the original result for a repeated authorisation key', async () => {
    const provider = new StubProvider();
    const first = await provider.authorise({ idempotencyKey: 'k1', amountPaise: 1000, currency: 'INR', reference: 'j' });
    const second = await provider.authorise({ idempotencyKey: 'k1', amountPaise: 1000, currency: 'INR', reference: 'j' });
    expect(second).toEqual(first);
  });

  // THE REFUSAL THAT MAKES "never truncate" A RULE AT ALL.
  it('refuses a capture larger than the hold', async () => {
    const provider = new StubProvider();
    const auth = await provider.authorise({ idempotencyKey: 'k2', amountPaise: 1000, currency: 'INR', reference: 'j' });
    if (auth.outcome !== 'AUTHORISED') throw new Error('expected an authorisation');

    const result = await provider.capture({ idempotencyKey: 'c1', authorisationRef: auth.externalRef, amountPaise: 1500 });
    expect(result.outcome).toBe('DECLINED');
  });

  it('captures once for a repeated capture key', async () => {
    const provider = new StubProvider();
    const auth = await provider.authorise({ idempotencyKey: 'k3', amountPaise: 1000, currency: 'INR', reference: 'j' });
    if (auth.outcome !== 'AUTHORISED') throw new Error('expected an authorisation');

    await provider.capture({ idempotencyKey: 'c2', authorisationRef: auth.externalRef, amountPaise: 600 });
    await provider.capture({ idempotencyKey: 'c2', authorisationRef: auth.externalRef, amountPaise: 600 });
    expect(provider.heldAmount(auth.externalRef)?.capturedPaise).toBe(600);
  });

  it('distinguishes a decline from being unreachable', async () => {
    const declining = new FailingStubProvider('DECLINED');
    const unreachable = new FailingStubProvider('UNREACHABLE');
    const request = { idempotencyKey: 'k', amountPaise: 1, currency: 'INR', reference: 'j' };
    expect((await declining.authorise(request)).outcome).toBe('DECLINED');
    expect((await unreachable.authorise(request)).outcome).toBe('UNREACHABLE');
  });
});

// ---------------------------------------------------------------------------

describe('the settlement path is pinned at job creation', () => {
  it('resolves a contracted fleet to monthly invoicing', async () => {
    const result = await createJobFor(FLEET, 'fleet-vehicle');
    expect(result.settlementPath).toBe('FLEET_TENANT');
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: result.jobId },
      select: { settlementPath: true },
    });
    expect(job.settlementPath).toBe('FLEET_TENANT');
  });

  it('resolves a covered consumer to zero payable', async () => {
    const result = await createJobFor(CONSUMER, 'consumer-vehicle');
    expect(result.settlementPath).toBe('CONTRACT_CONSUMER');
  });

  it('resolves an uncontracted consumer to the gateway path', async () => {
    const result = await createJobFor(WALKIN, 'walkin-vehicle');
    expect(result.settlementPath).toBe('WALK_IN');
  });

  it('records the decision on the audit trail as well as the column', async () => {
    const result = await createJobFor(WALKIN, 'walkin-vehicle');
    const created = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId: result.jobId, eventType: 'JOB_CREATED' },
      select: { payload: true },
    });
    expect(created.payload).toMatchObject({ settlementPath: 'WALK_IN' });
  });
});

describe('commit authorises the callout fee only', () => {
  it('holds exactly the callout fee for a walk-in', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new RecordingProvider();

    const result = await authoriseCallout(prismaBase, { jobId, provider });
    expect(result.outcome).toBe('AUTHORISED');
    if (result.outcome !== 'AUTHORISED') return;
    // The callout fee, and NOT the eventual repair — nobody knows that yet.
    expect(result.amountPaise).toBe(CALLOUT_PAISE);

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true, amountPaise: true, authorisation: { select: { amountPaise: true, status: true } } },
    });
    expect(payment.status).toBe('AUTHORISED');
    expect(payment.authorisation?.amountPaise).toBe(CALLOUT_PAISE);
  });

  // THE BRIEF'S OWN CHECK, asserted on the PROVIDER rather than on our rows: a
  // test that only looked for a missing payment row would pass even if we had
  // called a gateway and discarded the answer.
  it('never calls the provider at all for a GOLD fleet job', async () => {
    const { jobId } = await createJobFor(FLEET, 'fleet-vehicle');
    const provider = new RecordingProvider();

    const result = await authoriseCallout(prismaBase, { jobId, provider });
    expect(result.outcome).toBe('NO_GATEWAY');
    expect(provider.calls).toEqual([]);
    expect(await prismaBase.payment.count({ where: { jobId } })).toBe(0);
  });

  it('never calls the provider for a covered consumer either', async () => {
    const { jobId } = await createJobFor(CONSUMER, 'consumer-vehicle');
    const provider = new RecordingProvider();

    expect((await authoriseCallout(prismaBase, { jobId, provider })).outcome).toBe('NO_GATEWAY');
    expect(provider.calls).toEqual([]);
  });

  // PAYMENT IS NEVER ON THE DISPATCH CRITICAL PATH. A stranded driver does not
  // wait for a card to clear.
  it('leaves the payment flagged and the job dispatchable when the provider is down', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    await prismaBase.job.update({ where: { id: jobId }, data: { status: 'COMMITTED' } });

    const result = await authoriseCallout(prismaBase, {
      jobId,
      provider: new FailingStubProvider('UNREACHABLE'),
    });
    expect(result.outcome).toBe('PENDING_AUTHORISATION');

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true },
    });
    expect(payment.status).toBe('PENDING_AUTHORISATION');

    // THE JOB IS UNTOUCHED. It committed and it stays committed.
    const job = await prismaBase.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } });
    expect(job.status).toBe('COMMITTED');

    // AND AN OPERATOR CAN SEE IT — invariant 8. The job event is what puts it
    // on the dispatcher's incident timeline.
    expect(
      await prismaBase.jobEvent.count({ where: { jobId, eventType: 'PAYMENT_AUTHORISATION_PENDING' } }),
    ).toBe(1);
  });

  it('is recovered later by the retry sweep', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    await authoriseCallout(prismaBase, { jobId, provider: new FailingStubProvider('UNREACHABLE') });

    // SCOPED TO THIS TEST'S JOB. The sweep is global in production and another
    // suite calls it too, so an unscoped call here would authorise their
    // pending payment and leave them asserting against a backlog this file
    // cleared.
    const recovered = await retryPendingAuthorisations(prismaBase, {
      provider: new StubProvider(),
      jobIds: [jobId],
    });
    expect(recovered).toBeGreaterThanOrEqual(1);

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true },
    });
    expect(payment.status).toBe('AUTHORISED');
  });
});

describe('completion captures the approved total', () => {
  it('takes a second authorisation rather than truncating', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new StubProvider();
    await authoriseCallout(prismaBase, { jobId, provider });

    // Approved well above the callout-only hold — the ordinary case.
    const approvedPaise = 234000;
    await approveEstimate(jobId, approvedPaise);

    const result = await captureOnCompletion(prismaBase, { jobId, provider });
    expect(result.outcome).toBe('CAPTURED');
    if (result.outcome !== 'CAPTURED') return;
    // NOT the ₹300 that was held.
    expect(result.amountPaise).toBe(approvedPaise);
    expect(result.secondAuthorisation).toBe(true);

    // Two captures: the original hold, then the shortfall.
    const captures = await prismaBase.capture.findMany({
      where: { paymentId: result.paymentId },
      select: { amountPaise: true },
      orderBy: { amountPaise: 'asc' },
    });
    expect(captures.map((c) => c.amountPaise)).toEqual([CALLOUT_PAISE, approvedPaise - CALLOUT_PAISE]);

    const payment = await prismaBase.payment.findUniqueOrThrow({
      where: { id: result.paymentId },
      select: { status: true, amountPaise: true },
    });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.amountPaise).toBe(approvedPaise);
  });

  it('captures once when the same completion runs twice', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    const provider = new StubProvider();
    await authoriseCallout(prismaBase, { jobId, provider });
    await approveEstimate(jobId, 120000);

    const first = await captureOnCompletion(prismaBase, { jobId, provider });
    const second = await captureOnCompletion(prismaBase, { jobId, provider });
    expect(first.outcome).toBe('CAPTURED');
    expect(second.outcome).toBe('CAPTURED');

    if (first.outcome !== 'CAPTURED') return;
    // Two capture rows exist from the ONE completion (hold + top-up); the
    // second call added none.
    expect(await prismaBase.capture.count({ where: { paymentId: first.paymentId } })).toBe(2);
  });

  it('fails loudly rather than charging less when the top-up is declined', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    await authoriseCallout(prismaBase, { jobId, provider: new StubProvider() });
    await approveEstimate(jobId, 500000);

    const result = await captureOnCompletion(prismaBase, {
      jobId,
      provider: new FailingStubProvider('DECLINED'),
    });
    expect(result.outcome).toBe('CAPTURE_FAILED');

    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { status: true, amountPaise: true },
    });
    // FAILED, and the amount is NOT quietly reduced to what was held.
    expect(payment.status).toBe('FAILED');
    expect(payment.amountPaise).toBe(CALLOUT_PAISE);
    // And nothing was taken at all — not even the part that WAS held.
    expect(await prismaBase.capture.count({ where: { payment: { jobId } } })).toBe(0);
  });

  // PARTIAL CAPTURE -> REMAINDER VOIDED. The brief's own list names this and
  // stage 3 implemented it without proving it: the ordinary flows never produce
  // a capture SMALLER than the hold, because an estimate always includes the
  // callout fee the hold was for. So it is exercised directly — a hold of ₹500
  // (highway callout) against an approved total of ₹400.
  //
  // Leaving the difference held would keep ₹100 of a customer's money frozen
  // until the provider's expiry, for a job that is finished and paid.
  it('voids the remainder when the capture is smaller than the hold', async () => {
    const { jobId } = await createJobFor(WALKIN, 'walkin-vehicle');
    // A highway job: the callout fee is ₹500 rather than ₹300.
    await prismaBase.job.update({ where: { id: jobId }, data: { onHighway: true } });

    const provider = new StubProvider();
    const authorised = await authoriseCallout(prismaBase, { jobId, provider });
    expect(authorised.outcome).toBe('AUTHORISED');
    if (authorised.outcome !== 'AUTHORISED') return;
    expect(authorised.amountPaise).toBe(50000);

    // Approved for LESS than was held.
    await approveEstimate(jobId, 40000);

    const result = await captureOnCompletion(prismaBase, { jobId, provider });
    expect(result.outcome).toBe('CAPTURED');
    if (result.outcome !== 'CAPTURED') return;
    expect(result.amountPaise).toBe(40000);
    // No top-up was needed.
    expect(result.secondAuthorisation).toBe(false);

    // Exactly one capture, for the approved total and not the held amount.
    const captures = await prismaBase.capture.findMany({
      where: { paymentId: result.paymentId },
      select: { amountPaise: true },
    });
    expect(captures.map((c) => c.amountPaise)).toEqual([40000]);

    // AND THE REMAINDER IS RELEASED. Asserted on the PROVIDER — the hold is
    // voided there, not merely marked settled in our own rows.
    const payment = await prismaBase.payment.findFirstOrThrow({
      where: { jobId },
      select: { externalRef: true },
    });
    expect(provider.heldAmount(payment.externalRef ?? '')?.voided).toBe(true);
    expect(
      await prismaBase.paymentEvent.count({
        where: { payment: { jobId }, type: 'REMAINDER_VOIDED' },
      }),
    ).toBe(1);
  });

  it('does not capture on a path that has no gateway', async () => {
    const { jobId } = await createJobFor(FLEET, 'fleet-vehicle');
    const provider = new RecordingProvider();
    expect((await captureOnCompletion(prismaBase, { jobId, provider })).outcome).toBe('NO_GATEWAY');
    expect(provider.calls).toEqual([]);
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
    location: { lat: 12.9352, lng: 77.6245, headingDegrees: null, nearestExit: null, kmMarker: null, landmark: null, roadPosition: 'PARKING', parkingLevel: null },
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
      code: 'PAY',
      name: 'Payment Zone',
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
      make: 'Payment Motors',
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
    create: { id: `${PREFIX}-tier`, name: 'GOLD', description: 'Payment fixture tier', priority: 30 },
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
      create: { id: tenant.id, name: `Payment ${tenant.id}`, kind: tenant.kind },
    });

    if (tenant.contract) {
      await prismaBase.contract.upsert({
        where: { id: `${tenant.id}-contract` },
        // EVERY FIELD THIS FIXTURE CARES ABOUT, on the update as well as the
        // create. An `update` naming only what changed leaves the rest at
        // whatever an earlier version of this file wrote — which is exactly how
        // moving CREATED_AT left these contracts starting in 2030 and every
        // path resolving to WALK_IN. Third time this project has hit it.
        update: { active: true, startsAt: new Date('2019-01-01T00:00:00.000Z'), endsAt: null },
        create: {
          id: `${tenant.id}-contract`,
          tenantId: tenant.id,
          tierId: `${PREFIX}-tier`,
          name: `${tenant.id} contract`,
          // Before CREATED_AT, or no contract is active when the job is
          // raised and every path resolves to WALK_IN.
          startsAt: new Date('2019-01-01T00:00:00.000Z'),
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
        registration: `KA01PY${who.slice(0, 4).toUpperCase()}`,
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
      name: 'Payment Fixture List',
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
