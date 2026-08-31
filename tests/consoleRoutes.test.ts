// The dispatch console's two read endpoints, over HTTP.
//
// Both are pure reads over data earlier phases wrote, so the tests are about
// three things a read endpoint gets wrong: who may call it, whether the
// filters actually filter, and whether it is honest about what it does not
// have. The third matters here more than usual — `decision_records` is empty,
// and the inspector must not imply otherwise.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';

const app = createApp();
const PREFIX = 'console';
const TENANT = `${PREFIX}-tenant`;

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-dispatcher`,
    role: 'DISPATCHER',
    tenantId: null,
    crossTenant: true,
  });
}

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-driver`,
  });
}

let jobA = '';
let jobB = '';

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('GET /events — the incident timeline', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/events')).status).toBe(401);
  });

  it('returns events newest first', async () => {
    const response = await request(app)
      .get('/events')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    const times = response.body.events.map((event: { at: string }) => Date.parse(event.at));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it('filters by job', async () => {
    const response = await request(app)
      .get(`/events?jobId=${jobA}`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.events.length).toBeGreaterThan(0);
    for (const event of response.body.events) expect(event.jobId).toBe(jobA);
  });

  // Zone lives on the JOB, not the event, so this is the filter most likely to
  // be quietly wrong — it has to traverse a relation.
  it('filters by zone', async () => {
    const response = await request(app)
      .get(`/events?zoneId=${PREFIX}-zone-b`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.events.length).toBeGreaterThan(0);
    for (const event of response.body.events) expect(event.zoneId).toBe(`${PREFIX}-zone-b`);
    // And it genuinely excludes the other zone's job.
    expect(response.body.events.some((e: { jobId: string }) => e.jobId === jobA)).toBe(false);
  });

  it('filters by event type', async () => {
    const response = await request(app)
      .get('/events?eventType=CONSOLE_TEST_ALPHA')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.events.length).toBeGreaterThan(0);
    for (const event of response.body.events) expect(event.eventType).toBe('CONSOLE_TEST_ALPHA');
  });

  it('combines filters', async () => {
    const response = await request(app)
      .get(`/events?jobId=${jobA}&eventType=CONSOLE_TEST_ALPHA`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    for (const event of response.body.events) {
      expect(event.jobId).toBe(jobA);
      expect(event.eventType).toBe('CONSOLE_TEST_ALPHA');
    }
  });

  // An unbounded query over an append-only table gets slower every day, so the
  // cap is not a nicety.
  it('caps the page size however large a limit is asked for', async () => {
    const response = await request(app)
      .get('/events?limit=99999')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.body.limit).toBe(500);
    expect(response.body.events.length).toBeLessThanOrEqual(500);
  });

  it('offers the filter options that actually exist in the data', async () => {
    const response = await request(app)
      .get('/events')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    const types = response.body.eventTypes.map((row: { eventType: string }) => row.eventType);
    expect(types).toContain('CONSOLE_TEST_ALPHA');
    expect(response.body.zones.length).toBeGreaterThan(0);
  });
});

describe('GET /jobs/:id/decision — why this technician?', () => {
  it('is dispatcher-only', async () => {
    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(response.status).toBe(403);
  });

  it('404s a job that does not exist', async () => {
    const response = await request(app)
      .get('/jobs/no-such-job/decision')
      .set('Authorization', `Bearer ${dispatcherToken()}`);
    expect(response.status).toBe(404);
  });

  it('renders the chosen option with a term-by-term cost breakdown', async () => {
    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.solverRun.trigger).toBe('CONSOLE_TEST');
    expect(response.body.chosen).toHaveLength(1);

    const chosen = response.body.chosen[0];
    expect(chosen.unitId).toBe(`${PREFIX}-unit-good`);
    expect(chosen.coveredFaultProbability).toBeCloseTo(0.9, 5);
    // The terms themselves, not just a total — a total hides the one term that
    // explains the decision.
    expect(Object.keys(chosen.costBreakdown)).toEqual(
      expect.arrayContaining(['total', 'expectedTimeToResolution', 'capabilityShortfallRisk']),
    );
    expect(chosen.costBreakdown.expectedTimeToResolution.unit).toBe('minutes');
  });

  it('renders every rejected alternative with its feasibility reason code', async () => {
    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    const codes = response.body.rejected.map((row: { rejectionCode: string }) => row.rejectionCode);
    expect(codes).toContain('CAPABILITY_MISSING');
    expect(codes).toContain('UNIT_UNAVAILABLE');

    const missing = response.body.rejected.find(
      (row: { rejectionCode: string }) => row.rejectionCode === 'CAPABILITY_MISSING',
    );
    // "Why not the nearer van?" has to be answerable as a sentence.
    expect(missing.rejectionDetail).toMatch(/EV_HV_CERTIFICATION/);
    expect(missing.missingCapabilities).toContain('EV_HV_CERTIFICATION');
  });

  // THE HONESTY TEST. `decision_records` has no writer, so the endpoint must
  // not imply it is showing a record of what a human decided.
  it('says plainly that there is no DecisionRecord behind this', async () => {
    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.body.decisionRecord).toBeNull();
    expect(response.body.decisionRecordNote).toMatch(/no writer/i);
    expect(await prismaBase.decisionRecord.count()).toBe(0);
  });

  it('returns an empty decision for a job no solve has considered', async () => {
    const response = await request(app)
      .get(`/jobs/${jobB}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.solverRun).toBeNull();
    expect(response.body.chosen).toEqual([]);
    expect(response.body.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two jobs in two zones, one of them with a hand-written solver run carrying a
// chosen option and two rejections. Written directly rather than by running a
// solve, because these tests are about RENDERING a decision, and a real solve
// would make the fixture depend on the seeded fleet and the clock.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Console Tenant', kind: 'FLEET' },
  });
  for (const suffix of ['a', 'b']) {
    await prismaBase.zone.upsert({
      where: { id: `${PREFIX}-zone-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-zone-${suffix}`,
        code: `CNS${suffix.toUpperCase()}`,
        name: `Console Zone ${suffix.toUpperCase()}`,
        city: 'Bengaluru',
        centroidLat: 12.9352,
        centroidLng: 77.6245,
      },
    });
  }
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'TEST_CONSOLE',
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
      email: 'console-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Console Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: {
      id: `${PREFIX}-driver`,
      userId: `${PREFIX}-driver-user`,
      tenantId: TENANT,
      homeZoneId: `${PREFIX}-zone-a`,
    },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'CNS00001',
      colour: 'White',
    },
  });

  // `dispatch_options.unit_id` and `.technician_id` are real foreign keys, so
  // the three options below need three real crews behind them. No
  // capabilities are attached: this file writes dispatch_options directly
  // rather than running a solve, so nothing here reads a capability.
  for (const suffix of ['good', 'near', 'busy']) {
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-tech-user-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-tech-user-${suffix}`,
        email: `console-${suffix}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: `Console ${suffix}`,
      },
    });
    await prismaBase.technician.upsert({
      where: { id: `${PREFIX}-tech-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-tech-${suffix}`,
        userId: `${PREFIX}-tech-user-${suffix}`,
        employeeCode: `CNS-${suffix.toUpperCase()}`,
        homeZoneId: `${PREFIX}-zone-a`,
        active: true,
      },
    });
    await prismaBase.unit.upsert({
      where: { id: `${PREFIX}-unit-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-unit-${suffix}`,
        code: `CNS-U-${suffix.toUpperCase()}`,
        kind: 'VAN',
        zoneId: `${PREFIX}-zone-a`,
        status: 'AVAILABLE',
        currentTechnicianId: `${PREFIX}-tech-${suffix}`,
        lat: 12.9352,
        lng: 77.6245,
      },
    });
  }

  const stamp = Date.now();
  jobA = `${PREFIX}-job-a-${stamp}`;
  jobB = `${PREFIX}-job-b-${stamp}`;

  for (const [id, zone] of [
    [jobA, `${PREFIX}-zone-a`],
    [jobB, `${PREFIX}-zone-b`],
  ] as const) {
    await prismaBase.job.create({
      data: {
        id,
        tenantId: TENANT,
        driverId: `${PREFIX}-driver`,
        vehicleId: `${PREFIX}-vehicle`,
        zoneId: zone,
        status: 'PLANNED',
        safetyLevel: id === jobA ? 'HIGH_RISK' : 'NORMAL',
        lat: 12.9352,
        lng: 77.6245,
      },
    });
    await prismaBase.jobEvent.create({
      data: { jobId: id, sequence: 1, eventType: 'CONSOLE_TEST_ALPHA', actorRole: 'SYSTEM' },
    });
    await prismaBase.jobEvent.create({
      data: { jobId: id, sequence: 2, eventType: 'CONSOLE_TEST_BETA', actorRole: 'DISPATCHER' },
    });
  }

  await prismaBase.faultHypothesis.create({
    data: {
      jobId: jobA,
      distribution: { EV_HV_FAULT: 0.9, FLAT_BATTERY: 0.1 },
      requiredCapabilityCodes: ['EV_HV_CERTIFICATION'],
      entropy: 0.47,
      topFault: 'EV_HV_FAULT',
      version: 0,
    },
  });

  const run = await prismaBase.solverRun.create({
    data: {
      jobId: jobA,
      trigger: 'CONSOLE_TEST',
      snapshotHash: 'console-test-hash',
      optionCount: 3,
      feasibleCount: 1,
      wallClockMs: 12,
      zonePartitioned: false,
    },
    select: { id: true },
  });

  await prismaBase.dispatchOption.create({
    data: {
      solverRunId: run.id,
      jobId: jobA,
      unitId: `${PREFIX}-unit-good`,
      technicianId: `${PREFIX}-tech-good`,
      estimatedTravelMinutes: 7.5,
      coveredFaultProbability: 0.9,
      missingCapabilities: [],
      feasible: true,
      totalCost: 44.2,
      costBreakdown: {
        total: 44.2,
        weightVector: 'BALANCED',
        expectedTimeToResolution: { value: 44, unit: 'minutes', weighted: 44 },
        capabilityShortfallRisk: { value: 0.1, unit: 'probability', weighted: 0.1 },
        slaRisk: { value: 0.2, unit: 'probability', weighted: 0.05 },
        travelDistance: { value: 3.7, unit: 'kilometres', weighted: 0.03 },
        operationalCost: { value: 5400, unit: 'paise', weighted: 0.02 },
      },
    },
  });

  await prismaBase.dispatchOption.createMany({
    data: [
      {
        solverRunId: run.id,
        jobId: jobA,
        unitId: `${PREFIX}-unit-near`,
        technicianId: `${PREFIX}-tech-near`,
        estimatedTravelMinutes: 2.1,
        coveredFaultProbability: 0.1,
        missingCapabilities: ['EV_HV_CERTIFICATION'],
        feasible: false,
        rejectionCode: 'CAPABILITY_MISSING',
        rejectionDetail: 'missing: EV_HV_CERTIFICATION',
      },
      {
        solverRunId: run.id,
        jobId: jobA,
        unitId: `${PREFIX}-unit-busy`,
        technicianId: `${PREFIX}-tech-busy`,
        estimatedTravelMinutes: 4.4,
        coveredFaultProbability: 0.9,
        missingCapabilities: [],
        feasible: false,
        rejectionCode: 'UNIT_UNAVAILABLE',
        rejectionDetail: 'unit is on_job',
      },
    ],
  });
}
