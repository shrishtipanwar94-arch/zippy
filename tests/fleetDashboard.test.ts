// PHASE 21 — the fleet dashboard's assembly against a real Postgres, and the
// phase check itself: a fleet vehicle with prior battery incidents asks FEWER
// intake questions than an unknown vehicle with identical symptoms.
//
// TWO WAYS OF CALLING THE SAME CODE. `buildFleetDashboard` is called directly
// with an EXPLICIT `now` for every assertion that depends on "this month" or
// "already breached" — the same reason tests/cost.test.ts and
// tests/solve.test.ts freeze `now` rather than reading the real clock: a test
// whose pass/fail depended on which day of the month it happened to run would
// not be a test. `GET /fleet/dashboard` is exercised once, separately, for
// what only the route can prove — permission and tenant isolation — using
// data that does not depend on the calendar.
//
// SCOPED TO THIS FILE'S OWN ROWS. `fd-` throughout; the cross-tenant fixture
// is a second, disjoint tenant so isolation is checked against a REAL other
// fleet's data, not an empty one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { buildFleetDashboard } from '../src/commit/fleetDashboard.js';
import { createIntakeJob } from '../src/intake/createJob.js';

const app = createApp();
const P = 'fd';
const TENANT = `${P}-fleet`;
const OTHER_TENANT = `${P}-other-fleet`;

// Frozen for every "this month" / "current exposure" assertion.
const NOW = new Date('2026-06-15T12:00:00Z');
const START_OF_MONTH = new Date('2026-06-01T00:00:00Z');

const GOLD_PENALTY_PAISE = 250_000;

beforeAll(async () => {
  await clearFixture();
  await buildFixture();
}, 60_000);

afterAll(async () => {
  await clearFixture();
  await prismaBase.$disconnect().catch(() => undefined);
});

// ---------------------------------------------------------------------------

describe('buildFleetDashboard — the numbers, against a frozen clock', () => {
  it('lists only ACTIVE incidents, newest first', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);

    const activeIds = dashboard.activeIncidents.map((incident) => incident.jobId);
    expect(activeIds).toContain(`${P}-active-undecided`);
    expect(activeIds).toContain(`${P}-active-breached`);
    // A resolved job is not "active", however recent.
    expect(activeIds).not.toContain(`${P}-resolved-this-month`);

    const first = dashboard.activeIncidents[0]!;
    const second = dashboard.activeIncidents[1]!;
    expect(new Date(first.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(second.createdAt).getTime(),
    );
  });

  it('computes SLA met % over decided jobs this month only', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);

    // decided this month: sla-met (MET) and active-breached (BREACHED,
    // created this month) — active-undecided is still inside its window and
    // must not appear in either half of the fraction.
    expect(dashboard.slaDecidedCount).toBe(2);
    expect(dashboard.slaMetPercent).toBe(50);
  });

  it('prices current exposure from active, already-breached incidents only', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);
    // Only active-breached qualifies: sla-met arrived in time, active-undecided
    // has not decided yet, and the resolved job is not active.
    expect(dashboard.currentExposurePaise).toBe(GOLD_PENALTY_PAISE);
  });

  it('averages resolution time and sums spend over jobs resolved this month', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);
    // Two jobs resolved this month: fd-sla-met (50 minutes, no estimate — zero
    // spend) and fd-resolved-this-month (60 minutes, Rs 1,000 approved). The
    // three repeat-pattern incidents are dated in the PREVIOUS month
    // specifically so they cannot also land in this count.
    expect(dashboard.resolvedCount).toBe(2);
    expect(dashboard.meanResolutionMinutes).toBe(55);
    expect(dashboard.spendPaise).toBe(100_000);
  });

  it('flags the vehicle with a real repeat pattern and not the others', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);

    const repeatVehicle = dashboard.vehicles.find((v) => v.vehicleId === `${P}-vehicle-repeat`);
    expect(repeatVehicle?.repeatPatternFlag).not.toBeNull();
    expect(repeatVehicle?.repeatPatternFlag?.fault).toBe('FLAT_BATTERY');
    expect(repeatVehicle?.repeatPatternFlag?.message).toContain('Not a dispatch problem');

    // NOT fd-vehicle-a: earlier debugging of this very file called
    // createIntakeJob against it before this fixture settled on dedicated
    // vehicles for that test, and job_events being append-only means those
    // rows can never be removed from the shared test database. A vehicle
    // touched by nothing but this fixture's own single seeded incident is the
    // only way to make "no flag" a claim this file can still prove.
    const quietVehicle = dashboard.vehicles.find((v) => v.vehicleId === `${P}-vehicle-quiet`);
    expect(quietVehicle?.repeatPatternFlag).toBeNull();
  });

  it('sorts every flagged vehicle before every unflagged one', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);
    const flags = dashboard.vehicles.map((v) => v.repeatPatternFlag !== null);
    // Once the list turns to `false` it must never turn back to `true` — the
    // sort rule this asserts, independent of exactly how many vehicles happen
    // to be flagged in a shared test database.
    const firstUnflagged = flags.indexOf(false);
    if (firstUnflagged === -1) return; // every vehicle flagged — trivially sorted
    expect(flags.slice(firstUnflagged)).not.toContain(true);

    // And fd-vehicle-repeat, this fixture's own deliberate pattern, is
    // definitely one of the flagged ones.
    const repeatVehicle = dashboard.vehicles.find((v) => v.vehicleId === `${P}-vehicle-repeat`);
    expect(dashboard.vehicles.indexOf(repeatVehicle!)).toBeLessThan(firstUnflagged);
  });

  it('never returns another tenant’s vehicle or incident', async () => {
    const dashboard = await buildFleetDashboard(prismaBase, TENANT, NOW);
    const vehicleIds = dashboard.vehicles.map((v) => v.vehicleId);
    expect(vehicleIds).not.toContain(`${P}-other-vehicle`);
    expect(dashboard.activeIncidents.some((i) => i.jobId === `${P}-other-active`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('GET /fleet/dashboard — permission and tenant isolation', () => {
  it('refuses a role other than FLEET_MANAGER', async () => {
    const response = await request(app)
      .get('/fleet/dashboard')
      .set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get('/fleet/dashboard');
    expect(response.status).toBe(401);
  });

  it('returns this fleet’s own dashboard, money already formatted', async () => {
    const response = await request(app)
      .get('/fleet/dashboard')
      .set('Authorization', `Bearer ${fleetManagerToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.tenantId).toBe(TENANT);
    expect(response.body.currentExposureRupees).toEqual(expect.any(String));
    expect(response.body.spendRupees).toEqual(expect.any(String));

    const vehicleIds = response.body.vehicles.map((v: { vehicleId: string }) => v.vehicleId);
    expect(vehicleIds).not.toContain(`${P}-other-vehicle`);
  });

  it('gives the other fleet manager a disjoint dashboard', async () => {
    const response = await request(app)
      .get('/fleet/dashboard')
      .set('Authorization', `Bearer ${otherFleetManagerToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.tenantId).toBe(OTHER_TENANT);
    const vehicleIds = response.body.vehicles.map((v: { vehicleId: string }) => v.vehicleId);
    expect(vehicleIds).toEqual([`${P}-other-vehicle`]);
  });
});

// ---------------------------------------------------------------------------
// THE PHASE'S OWN CHECK: a fleet vehicle with prior battery incidents asks
// fewer intake questions than an unknown vehicle with identical symptoms.

describe('the intake prior — a fleet vehicle starts from a sharper belief', () => {
  it('asks nothing further for a vehicle with two prior battery incidents, and something for one with none', async () => {
    const symptoms = {
      primaryComplaint: 'WONT_START' as const,
      engineCranks: null,
      warningLights: [],
      unusualSound: null,
      vehicleMoves: null,
    };
    const safety = {
      trafficSpeedKph: null,
      blockingLiveLane: false,
      smokeOrBurningSmell: false,
      fuelSmell: false,
      overheating: false,
      driverAlone: false,
      vulnerablePassengers: false,
    };
    const location = {
      lat: 12.9352,
      lng: 77.6245,
      headingDegrees: null,
      nearestExit: null,
      kmMarker: null,
      landmark: null,
      roadPosition: 'PARKING' as const,
      parkingLevel: null,
    };

    // A DEDICATED vehicle, never touched by the dashboard describe block
    // above — createIntakeJob writes real, undeletable job_events, so reusing
    // fd-vehicle-repeat here would grow its incident count by one on every
    // rerun of this file and eventually break that block's exact `count`
    // assertion. fd-vehicle-prior-history carries two seeded prior
    // FLAT_BATTERY incidents and nothing else ever touches it.
    const withHistory = await createIntakeJob(prismaBase, {
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-prior-history`,
      tenantId: TENANT,
      symptoms,
      safety,
      location,
      actor: { role: 'DRIVER', id: `${P}-driver` },
      at: new Date('2026-06-15T13:00:00Z'),
    });

    // Also dedicated, and also never seeded — the control. Not fd-vehicle-a:
    // that vehicle is asserted to carry NO repeat-pattern flag above, and a
    // job created here would put a FLAT_BATTERY incident on it every rerun.
    const withoutHistory = await createIntakeJob(prismaBase, {
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-prior-control`,
      tenantId: TENANT,
      symptoms,
      safety,
      location,
      actor: { role: 'DRIVER', id: `${P}-driver` },
      at: new Date('2026-06-15T13:00:00Z'),
    });

    expect(withHistory.entropyBits).toBeLessThan(withoutHistory.entropyBits);
    // The sharper prior is sharp enough to stop asking immediately; the
    // control, with the identical stated symptom and no history, still has a
    // question to ask.
    expect(withHistory.next.done).toBe(true);
    expect(withoutHistory.next.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture

function fleetManagerToken(): string {
  return issueAccessToken({
    sub: `${P}-fm-user`,
    role: 'FLEET_MANAGER',
    tenantId: TENANT,
    crossTenant: false,
  });
}

function otherFleetManagerToken(): string {
  return issueAccessToken({
    sub: `${P}-other-fm-user`,
    role: 'FLEET_MANAGER',
    tenantId: OTHER_TENANT,
    crossTenant: false,
  });
}

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${P}-dispatcher-user`,
    role: 'DISPATCHER',
    tenantId: null,
    crossTenant: true,
  });
}

async function upsertFaultHypothesis(jobId: string, topFault: string, createdAt: Date): Promise<void> {
  await prismaBase.faultHypothesis.create({
    data: {
      jobId,
      distribution: {},
      requiredCapabilityCodes: [],
      entropy: 0,
      topFault,
      version: 0,
      createdAt,
    },
  });
}

async function clearFixture(): Promise<void> {
  // job_events is append-only, so every job this file created is CANCELLED
  // rather than deleted — the same move the tenancy fixture (tests/contracts.test.ts)
  // makes and for the same reason.
  await prismaBase.job.updateMany({
    where: { tenantId: { in: [TENANT, OTHER_TENANT] }, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
}

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${P}-zone` },
    update: {},
    create: {
      id: `${P}-zone`,
      code: 'FDZ',
      name: 'Fleet Dashboard Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${P}-profile` },
    update: {},
    create: {
      id: `${P}-profile`,
      make: 'Fleet Dashboard Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  for (const [tenantId, suffix] of [
    [TENANT, ''],
    [OTHER_TENANT, 'other-'],
  ] as const) {
    await prismaBase.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: `Fleet Dashboard ${tenantId}`, kind: 'FLEET' },
    });
    await prismaBase.user.upsert({
      where: { id: `${P}-${suffix}fm-user` },
      update: {},
      create: {
        id: `${P}-${suffix}fm-user`,
        email: `${P}-${suffix}fm@example.test`,
        passwordHash: 'not-used',
        role: 'FLEET_MANAGER',
        name: 'Fixture Fleet Manager',
        memberships: { create: { id: `${P}-${suffix}mem`, tenantId, role: 'FLEET_MANAGER' } },
      },
    });
    await prismaBase.user.upsert({
      where: { id: `${P}-${suffix}driver-user` },
      update: {},
      create: {
        id: `${P}-${suffix}driver-user`,
        email: `${P}-${suffix}driver@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: 'Fixture Driver',
        driver: { create: { id: `${P}-${suffix}driver`, tenantId } },
      },
    });
  }

  // The GOLD contract, its response window, and its penalty.
  await prismaBase.contractTier.upsert({
    where: { id: `${P}-tier-gold` },
    update: {},
    create: { id: `${P}-tier-gold`, name: 'GOLD', priority: 30, description: 'Fixture GOLD' },
  });
  await prismaBase.contract.upsert({
    where: { id: `${P}-contract` },
    update: { active: true },
    create: {
      id: `${P}-contract`,
      tenantId: TENANT,
      tierId: `${P}-tier-gold`,
      name: 'Fleet dashboard fixture contract',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      active: true,
    },
  });
  await prismaBase.slaPolicy.upsert({
    where: { id: `${P}-sla-standard` },
    update: { responseMinutes: 30, breachPenaltyPaise: GOLD_PENALTY_PAISE },
    create: {
      id: `${P}-sla-standard`,
      contractId: `${P}-contract`,
      serviceType: 'STANDARD',
      responseMinutes: 30,
      resolutionMinutes: 90,
      breachPenaltyPaise: GOLD_PENALTY_PAISE,
    },
  });
  await prismaBase.coveredService.upsert({
    where: { contractId_serviceType: { contractId: `${P}-contract`, serviceType: 'STANDARD' } },
    update: {},
    create: { id: `${P}-covered-standard`, contractId: `${P}-contract`, serviceType: 'STANDARD', covered: true },
  });

  // Vehicles: one quiet, one with a real repeat pattern, two dedicated to the
  // intake-prior comparison (never touched anywhere else — see that test for
  // why), and one on the other tenant entirely.
  for (const [id, tenantId, driverId, registration] of [
    [`${P}-vehicle-a`, TENANT, `${P}-driver`, 'KA01FD0001'],
    [`${P}-vehicle-repeat`, TENANT, `${P}-driver`, 'KA01FD0002'],
    [`${P}-vehicle-prior-history`, TENANT, `${P}-driver`, 'KA01FD0003'],
    [`${P}-vehicle-prior-control`, TENANT, `${P}-driver`, 'KA01FD0004'],
    [`${P}-vehicle-quiet`, TENANT, `${P}-driver`, 'KA01FD0005'],
    [`${P}-other-vehicle`, OTHER_TENANT, `${P}-other-driver`, 'KA01FD0099'],
  ] as const) {
    await prismaBase.vehicle.upsert({
      where: { id },
      update: {},
      create: { id, driverId, tenantId, profileId: `${P}-profile`, registration, colour: 'White' },
    });
  }

  // ACTIVE, still inside its window — undecided.
  await prismaBase.job.upsert({
    where: { id: `${P}-active-undecided` },
    update: {
      status: 'EN_ROUTE',
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
      slaPolicyId: `${P}-sla-standard`,
    },
    create: {
      id: `${P}-active-undecided`,
      tenantId: TENANT,
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-a`,
      zoneId: `${P}-zone`,
      status: 'EN_ROUTE',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
      slaPolicyId: `${P}-sla-standard`,
    },
  });

  // ACTIVE, window closed, nobody arrived — a decided breach, both for SLA%
  // and for current exposure.
  await prismaBase.job.upsert({
    where: { id: `${P}-active-breached` },
    update: {
      status: 'PLANNED',
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      slaPolicyId: `${P}-sla-standard`,
    },
    create: {
      id: `${P}-active-breached`,
      tenantId: TENANT,
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-a`,
      zoneId: `${P}-zone`,
      status: 'PLANNED',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      slaPolicyId: `${P}-sla-standard`,
    },
  });

  // RESOLVED, arrived on time — MET, and not part of current exposure because
  // it is no longer active.
  await prismaBase.job.upsert({
    where: { id: `${P}-sla-met` },
    update: { status: 'RESOLVED', createdAt: new Date(NOW.getTime() - 90 * 60_000) },
    create: {
      id: `${P}-sla-met`,
      tenantId: TENANT,
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-a`,
      zoneId: `${P}-zone`,
      status: 'RESOLVED',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 90 * 60_000),
      resolvedAt: new Date(NOW.getTime() - 40 * 60_000),
      slaPolicyId: `${P}-sla-standard`,
    },
  });
  // job_events is append-only (no UPDATE, no DELETE), so this checks for the
  // row rather than deleting and recreating it — safe across repeated runs of
  // this fixture because NOW is a fixed instant, so the `at` this would write
  // is identical every time anyway.
  const existingArrival = await prismaBase.jobEvent.findFirst({
    where: { jobId: `${P}-sla-met`, eventType: 'TECHNICIAN_ARRIVED' },
    select: { id: true },
  });
  if (!existingArrival) {
    await prismaBase.jobEvent.create({
      data: {
        jobId: `${P}-sla-met`,
        sequence: 1,
        eventType: 'TECHNICIAN_ARRIVED',
        at: new Date(NOW.getTime() - 70 * 60_000), // 20 minutes in, inside the 30-minute window
      },
    });
  }

  // RESOLVED this month — mean resolution time and spend both read this one.
  await prismaBase.job.upsert({
    where: { id: `${P}-resolved-this-month` },
    update: { status: 'RESOLVED', createdAt: new Date(START_OF_MONTH.getTime() + 24 * 60 * 60_000) },
    create: {
      id: `${P}-resolved-this-month`,
      tenantId: TENANT,
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-a`,
      zoneId: `${P}-zone`,
      status: 'RESOLVED',
      safetyLevel: 'NORMAL',
      createdAt: new Date(START_OF_MONTH.getTime() + 24 * 60 * 60_000), // day 2, 00:00
      resolvedAt: new Date(START_OF_MONTH.getTime() + 24 * 60 * 60_000 + 60 * 60_000), // +60 min
    },
  });
  await prismaBase.estimate.deleteMany({ where: { jobId: `${P}-resolved-this-month` } });
  await prismaBase.estimate.create({
    data: {
      jobId: `${P}-resolved-this-month`,
      status: 'APPROVED',
      subtotalPaise: 100_000,
      totalPaise: 100_000,
      coveredPaise: 0,
    },
  });

  // Three prior FLAT_BATTERY incidents on fd-vehicle-repeat, spaced inside the
  // 60-day window and each carrying a settled FaultHypothesis — real history
  // for both the repeat-pattern flag and the intake-prior check.
  for (let i = 0; i < 3; i += 1) {
    const id = `${P}-repeat-incident-${i}`;
    // 20/35/50 days before NOW — all in the PREVIOUS calendar month, so none
    // of these can also be counted as "resolved this month".
    const createdAt = new Date(NOW.getTime() - (20 + i * 15) * 24 * 60 * 60_000);
    await prismaBase.job.upsert({
      where: { id },
      update: { status: 'RESOLVED', createdAt },
      create: {
        id,
        tenantId: TENANT,
        driverId: `${P}-driver`,
        vehicleId: `${P}-vehicle-repeat`,
        zoneId: `${P}-zone`,
        status: 'RESOLVED',
        safetyLevel: 'NORMAL',
        createdAt,
        resolvedAt: new Date(createdAt.getTime() + 45 * 60_000),
      },
    });
    await prismaBase.faultHypothesis.deleteMany({ where: { jobId: id } });
    await upsertFaultHypothesis(id, 'FLAT_BATTERY', createdAt);
  }

  // Two prior FLAT_BATTERY incidents on fd-vehicle-prior-history, dated well
  // before the intake-prior test's own `at` — the sharper starting belief that
  // test's assertion depends on. Kept separate from fd-vehicle-repeat above so
  // that block's exact incident count is never touched by this one.
  for (let i = 0; i < 2; i += 1) {
    const id = `${P}-prior-history-incident-${i}`;
    const createdAt = new Date(NOW.getTime() - (25 + i * 10) * 24 * 60 * 60_000);
    await prismaBase.job.upsert({
      where: { id },
      update: { status: 'RESOLVED', createdAt },
      create: {
        id,
        tenantId: TENANT,
        driverId: `${P}-driver`,
        vehicleId: `${P}-vehicle-prior-history`,
        zoneId: `${P}-zone`,
        status: 'RESOLVED',
        safetyLevel: 'NORMAL',
        createdAt,
        resolvedAt: new Date(createdAt.getTime() + 45 * 60_000),
      },
    });
    await prismaBase.faultHypothesis.deleteMany({ where: { jobId: id } });
    await upsertFaultHypothesis(id, 'FLAT_BATTERY', createdAt);
  }

  // ONE incident on fd-vehicle-quiet, and never anything more — this is what
  // "no repeat-pattern flag" is asserted against. One incident of any fault is
  // sub-threshold by construction, so this row exists purely to appear in
  // `dashboard.vehicles` with a genuine null flag rather than not appearing at
  // all (a vehicle with zero incidents is filtered out entirely).
  await prismaBase.job.upsert({
    where: { id: `${P}-quiet-incident` },
    update: {},
    create: {
      id: `${P}-quiet-incident`,
      tenantId: TENANT,
      driverId: `${P}-driver`,
      vehicleId: `${P}-vehicle-quiet`,
      zoneId: `${P}-zone`,
      status: 'RESOLVED',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 15 * 24 * 60 * 60_000),
      resolvedAt: new Date(NOW.getTime() - 15 * 24 * 60 * 60_000 + 45 * 60_000),
    },
  });
  await prismaBase.faultHypothesis.deleteMany({ where: { jobId: `${P}-quiet-incident` } });
  await upsertFaultHypothesis(`${P}-quiet-incident`, 'OUT_OF_FUEL', new Date(NOW.getTime() - 15 * 24 * 60 * 60_000));

  // The other tenant's own active incident — proves isolation, not just an
  // empty result.
  await prismaBase.job.upsert({
    where: { id: `${P}-other-active` },
    update: { status: 'EN_ROUTE', createdAt: new Date(NOW.getTime() - 5 * 60_000) },
    create: {
      id: `${P}-other-active`,
      tenantId: OTHER_TENANT,
      driverId: `${P}-other-driver`,
      vehicleId: `${P}-other-vehicle`,
      zoneId: `${P}-zone`,
      status: 'EN_ROUTE',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 5 * 60_000),
    },
  });
}
