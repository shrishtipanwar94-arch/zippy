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
import { selectPlan } from '../src/commit/decisionRecords.js';
import { labelForFault } from '../src/domain/driverNarrative.js';

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

  // Stage 1 asserted this endpoint admitted `decision_records` had no writer.
  // Stage 2 gave it one, so the claim changed: what must still be true is that
  // the response distinguishes a SOLVER PROPOSAL from a HUMAN DECISION, and
  // says which one is on screen.
  it('reports the solver proposal, not a decision, until someone selects a plan', async () => {
    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.body.decisionRecord).toBeNull();
    expect(response.body.overrideReasonCode).toBeNull();
    expect(response.body.runSource).toBe('latest-solve');
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
        city: 'Delhi',
        centroidLat: 28.6152,
        centroidLng: 77.2095,
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
        lat: 28.6152,
        lng: 77.2095,
      },
    });
  }

  // RETIRE EVERY EARLIER RUN'S JOBS FIRST. They carry job_events, which are
  // append-only, so they can never be deleted — and each one stayed PLANNED
  // forever. jobA is HIGH_RISK, the queue sorts HIGH_RISK first and oldest
  // first within it, so after ~200 runs the leftovers filled `/queue?limit=200`
  // and pushed this run's own jobA off the page. It failed exactly that way on
  // the 200th run. Cancelling takes them out of the queue's INTAKE/PLANNED
  // filter; only this file's prefix is touched (CLAUDE.md, GOTCHAS).
  await prismaBase.job.updateMany({
    where: { id: { startsWith: `${PREFIX}-job-` }, status: { in: ['INTAKE', 'PLANNED'] } },
    data: { status: 'CANCELLED' },
  });

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
        lat: 28.6152,
        lng: 77.2095,
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

  await writeOptions(run.id);
}

// One chosen option and two rejected ones, shared by the fixture's run and by
// every `freshRun()`. In one place so the two cannot drift into testing
// different worlds.
async function writeOptions(solverRunId: string): Promise<void> {
  await prismaBase.dispatchOption.create({
    data: {
      solverRunId,
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
        solverRunId,
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
        solverRunId,
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

describe('GET /capabilities/scarcity', () => {
  it('is not open to a driver', async () => {
    const response = await request(app)
      .get('/capabilities/scarcity')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(response.status).toBe(403);
  });

  // THE OPERATIVE NUMBER IS CREWED PAIRS. A capability on a van whose driver
  // is not certified in it cannot be dispatched, so the pair count must never
  // exceed either component count — that inequality is the whole claim the
  // panel makes.
  it('counts crews that can actually do the work, not units or technicians', async () => {
    const response = await request(app)
      .get('/capabilities/scarcity')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.capabilities.length).toBeGreaterThan(0);

    for (const row of response.body.capabilities) {
      expect(row.crewedPairs).toBeLessThanOrEqual(row.unitsWithCapability);
      expect(row.crewedPairs).toBeLessThanOrEqual(row.techniciansWithCapability);
      expect(row.crewedPairs).toBeLessThanOrEqual(response.body.totalCrewedUnits);
      expect(['ok', 'amber', 'red']).toContain(row.level);
    }
  });

  it('puts the scarcest capability first', async () => {
    const response = await request(app)
      .get('/capabilities/scarcity')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    const order = { red: 0, amber: 1, ok: 2 } as Record<string, number>;
    const levels = response.body.capabilities.map((row: { level: string }) => order[row.level]);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});

describe('GET /queue', () => {
  it('puts safety above everything, lexicographically', async () => {
    const response = await request(app)
      .get('/queue')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);

    const rank = { HIGH_RISK: 0, ELEVATED: 1, NORMAL: 2 } as Record<string, number>;
    const ranks = response.body.jobs.map((job: { safetyLevel: string }) => rank[job.safetyLevel]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // And the fixture's HIGH_RISK job is genuinely ahead of its NORMAL one,
    // which is the case that would break if the comparator were a weighted
    // score rather than a tiered one.
    const ids = response.body.jobs.map((job: { id: string }) => job.id);
    if (ids.includes(jobA) && ids.includes(jobB)) {
      expect(ids.indexOf(jobA)).toBeLessThan(ids.indexOf(jobB));
    }
  });

  it('shows the three sort keys so the order can be checked rather than trusted', async () => {
    const response = await request(app)
      .get('/queue')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    const job = response.body.jobs[0];
    expect(job).toHaveProperty('safetyLevel');
    expect(job).toHaveProperty('slaRisk');
    expect(job).toHaveProperty('ageMinutes');
  });

  // BOUNDED, AND HONEST ABOUT IT. `zippy_test` is shared, so these assert on
  // the relationship between the fields rather than on any absolute count —
  // another suite's pending jobs move `total` between runs and must not move
  // the verdict.
  it('returns the top of the queue rather than all of it, and says how many are waiting', async () => {
    const response = await request(app)
      .get('/queue')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(50);
    expect(response.body.jobs.length).toBeLessThanOrEqual(50);
    expect(response.body.total).toBeGreaterThanOrEqual(response.body.jobs.length);
    // Counted over every pending job, so it can legitimately exceed the rows.
    expect(response.body.slaAtRiskCount).toBeGreaterThanOrEqual(0);
    // Counted over every job the board has not finished with, which is a wider
    // population again — every queued job is active, plus everything already
    // assigned and on the road.
    expect(response.body.activeIncidentCount).toBeGreaterThanOrEqual(response.body.total);
  });

  // A row that carries urgency and no subject cannot be triaged without being
  // clicked. These are the three fields that say what the job actually is.
  it('names the vehicle, the fault and the place on every row', async () => {
    const response = await request(app)
      .get('/queue?limit=200')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    const own = response.body.jobs.find((job: { id: string }) => job.id === jobA);
    expect(own).toBeDefined();
    expect(own.registration).toBe('CNS00001');
    // The zone always ends the location string, so a job with no landmark and
    // no highway detail still says which part of the city it is in.
    expect(own.locationLabel).toContain('Console Zone A');
    // The fixture's newest hypothesis tops out at EV_HV_FAULT, and the row
    // carries the WORDED form rather than the code — the point of routing every
    // surface through labelForFault instead of letting each invent a phrase.
    expect(own.faultLabel).toBe(labelForFault('EV_HV_FAULT'));
  });

  it('honours an explicit limit without changing which job is first', async () => {
    const [full, one] = await Promise.all([
      request(app).get('/queue').set('Authorization', `Bearer ${dispatcherToken()}`),
      request(app).get('/queue?limit=1').set('Authorization', `Bearer ${dispatcherToken()}`),
    ]);

    expect(one.body.jobs).toHaveLength(1);
    expect(one.body.limit).toBe(1);
    // Truncation happens AFTER the sort, so the single row is the same job the
    // unbounded list put at the top — the property that would break if the
    // limit were pushed into the query.
    expect(one.body.jobs[0].id).toBe(full.body.jobs[0].id);
    expect(one.body.total).toBe(full.body.total);
  });

  it('clamps a limit past the maximum instead of trusting it', async () => {
    const response = await request(app)
      .get('/queue?limit=99999')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.body.limit).toBe(200);
    expect(response.body.jobs.length).toBeLessThanOrEqual(200);
  });

  // The console's map plots this list and nothing else, so a row without
  // coordinates is a row the map silently drops — which is exactly how it went
  // unnoticed that the select never asked for them.
  it('carries the coordinates the map plots', async () => {
    const response = await request(app)
      .get('/queue?limit=200')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    // RANK-INDEPENDENT, because the response is now the top of the queue and
    // this file's job does not get to assume it is near the top of a shared
    // database. The bug was the SELECT never asking for the columns, which
    // leaves the keys off EVERY row — so their presence is the property, and
    // it holds whichever jobs come back.
    expect(response.body.jobs.length).toBeGreaterThan(0);
    for (const job of response.body.jobs) {
      expect(job).toHaveProperty('lat');
      expect(job).toHaveProperty('lng');
    }

    // And when this file's own job is in range, the values are its own — the
    // stronger claim, made only when it can be made without depending on how
    // busy the test database is.
    const own = response.body.jobs.find((job: { id: string }) => job.id === jobA);
    if (own) {
      expect(own.lat).toBe(28.6152);
      expect(own.lng).toBe(77.2095);
    }
  });
});

describe('POST /plans/:id/select', () => {
  it('records the recommended plan with no reason needed', async () => {
    // Its own run: one decision is allowed per solve, so a test that shares a
    // run with another selection test is testing the order they happened to
    // run in.
    const plan = await planVariant('BALANCED', await freshRun());

    const response = await request(app)
      .post(`/plans/${plan}/select`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.isOverride).toBe(false);
    expect(response.body.decisionsRecorded).toBe(1);

    const record = await prismaBase.decisionRecord.findFirstOrThrow({
      where: { jobId: jobA },
      orderBy: { createdAt: 'desc' },
      select: { overrideReasonCode: true, selectedByRole: true, selectedOptionId: true, rejectedAlternatives: true },
    });
    expect(record.overrideReasonCode).toBeNull();
    expect(record.selectedByRole).toBe('DISPATCHER');
    expect(record.selectedOptionId).not.toBeNull();
    // The rejected alternatives travel with the decision, so "why not the
    // nearer van?" is answerable from the record itself.
    expect((record.rejectedAlternatives as unknown[]).length).toBe(2);
  });

  // THE POINT OF THE TABLE. Taking a plan the solver did not recommend is a
  // judgement the model did not make, and it has to explain itself or it
  // vanishes.
  it('refuses an override with no reason, before writing anything', async () => {
    const plan = await planVariant('FASTEST_RESOLUTION', await freshRun());
    const before = await prismaBase.decisionRecord.count();

    const response = await request(app)
      .post(`/plans/${plan}/select`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('override_reason_required');
    expect(response.body.recommended).toBe('BALANCED');
    // Refused BEFORE writing: a half-recorded override would put the
    // assignments on the record with no explanation.
    expect(await prismaBase.decisionRecord.count()).toBe(before);
  });

  it('records an override together with its reason', async () => {
    const plan = await planVariant('LOWEST_COST', await freshRun());

    const response = await request(app)
      .post(`/plans/${plan}/select`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({ overrideReasonCode: 'ring road closed since 14:02' });

    expect(response.status).toBe(200);
    expect(response.body.isOverride).toBe(true);

    const record = await prismaBase.decisionRecord.findFirstOrThrow({
      where: { jobId: jobA },
      orderBy: { createdAt: 'desc' },
      select: { overrideReasonCode: true },
    });
    expect(record.overrideReasonCode).toBe('ring road closed since 14:02');

    // And it is on the job's own timeline, distinct from an ordinary
    // selection, because the two mean different things to whoever reads it
    // later.
    expect(
      await prismaBase.jobEvent.count({ where: { jobId: jobA, eventType: 'PLAN_OVERRIDDEN' } }),
    ).toBeGreaterThan(0);
  });

  it('is not open to a driver', async () => {
    const plan = await planVariant('BALANCED', await freshRun());
    const response = await request(app)
      .post(`/plans/${plan}/select`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({});
    expect(response.status).toBe(403);
  });

  it('404s a plan that does not exist', async () => {
    const response = await request(app)
      .post('/plans/no-such-plan/select')
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});
    expect(response.status).toBe(404);
  });

  // THE STAGE 1 BUG. The inspector showed whichever solve had touched the job
  // most recently, which after Phase 13 is routinely a zone re-plan that
  // decided nothing about it. Once a human has selected a plan, the record of
  // that selection is the authoritative answer.
  it('makes the inspector show the decision a human made', async () => {
    const run = await freshRun();
    const plan = await planVariant('BALANCED', run);
    await request(app)
      .post(`/plans/${plan}/select`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});

    const response = await request(app)
      .get(`/jobs/${jobA}/decision`)
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.body.runSource).toBe('decision-record');
    expect(response.body.decisionRecord).not.toBeNull();
    // The run the DECISION points at, not whichever solve was newest — the
    // Stage 1 bug this fix exists for.
    expect(response.body.solverRun.id).toBe(run);
  });
});

describe('selecting a plan is idempotent', () => {
  // A JOB CANNOT HAVE ITS PLAN DECIDED TWICE FOR ONE SOLVE. Two dispatchers
  // watching the same board can both press Select, and without a guard the job
  // ends up with two decision records and two events describing incompatible
  // choices — with the inspector silently showing whichever landed last.
  //
  // The guard is a unique index on (job_id, solver_run_id), the same shape
  // Phases 5, 11 and 12 use: the database arbitrates, rather than a read
  // followed by a write with a window in between that both callers pass
  // through.
  it('lets exactly one of two CONCURRENT selections write', async () => {
    const plan = await planVariant('BALANCED', await freshRun());
    const before = await prismaBase.decisionRecord.count({ where: { jobId: jobA } });

    // Fired together, not one after the other — a sequential pair would be
    // caught by any check-then-write and proves nothing about the race.
    const [first, second] = await Promise.all([
      selectPlan(prismaBase, {
        planVariantId: plan,
        actor: { role: 'DISPATCHER', id: 'dispatcher-one' },
      }),
      selectPlan(prismaBase, {
        planVariantId: plan,
        actor: { role: 'DISPATCHER', id: 'dispatcher-two' },
      }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['ALREADY_SELECTED', 'RECORDED']);

    // EXACTLY ONE ROW, not two. This is the assertion that would fail on a
    // double-write even if both callers were somehow told they had won.
    expect(await prismaBase.decisionRecord.count({ where: { jobId: jobA } })).toBe(before + 1);
  });

  it('leaves no half-written plan behind when it loses', async () => {
    const plan = await planVariant('BALANCED', await freshRun());
    await selectPlan(prismaBase, {
      planVariantId: plan,
      actor: { role: 'DISPATCHER', id: 'dispatcher-one' },
    });

    const eventsBefore = await prismaBase.jobEvent.count({
      where: { jobId: jobA, eventType: 'PLAN_SELECTED' },
    });

    const again = await selectPlan(prismaBase, {
      planVariantId: plan,
      actor: { role: 'DISPATCHER', id: 'dispatcher-two' },
    });

    expect(again.outcome).toBe('ALREADY_SELECTED');
    // The loser's whole transaction rolled back, so it wrote no event either.
    expect(
      await prismaBase.jobEvent.count({ where: { jobId: jobA, eventType: 'PLAN_SELECTED' } }),
    ).toBe(eventsBefore);
  });

  // A DIFFERENT plan for the SAME solve is the same decision being made twice,
  // and is refused for the same reason.
  it('refuses a second, contradicting plan for the same solve', async () => {
    const run = await freshRun();
    const balanced = await planVariant('BALANCED', run);
    const fastest = await planVariant('FASTEST_RESOLUTION', run);

    const first = await selectPlan(prismaBase, {
      planVariantId: balanced,
      actor: { role: 'DISPATCHER', id: 'dispatcher-one' },
    });
    expect(first.outcome).toBe('RECORDED');

    const second = await selectPlan(prismaBase, {
      planVariantId: fastest,
      actor: { role: 'DISPATCHER', id: 'dispatcher-two' },
      overrideReasonCode: 'changed my mind',
    });
    expect(second.outcome).toBe('ALREADY_SELECTED');
  });

  // But a LATER solve is a genuinely new decision — a re-dispatch, a changed
  // diagnosis — and must stay recordable. The constraint is scoped to the run
  // precisely so this keeps working.
  it('allows a decision on a later solve for the same job', async () => {
    const runOne = await freshRun();
    const runTwo = await freshRun();

    const first = await selectPlan(prismaBase, {
      planVariantId: await planVariant('BALANCED', runOne),
      actor: { role: 'DISPATCHER', id: 'dispatcher-one' },
    });
    const second = await selectPlan(prismaBase, {
      planVariantId: await planVariant('BALANCED', runTwo),
      actor: { role: 'DISPATCHER', id: 'dispatcher-one' },
    });

    expect(first.outcome).toBe('RECORDED');
    expect(second.outcome).toBe('RECORDED');
  });

  it('reports the conflict over HTTP as a 409', async () => {
    const plan = await planVariant('BALANCED', await freshRun());
    const send = () =>
      request(app)
        .post(`/plans/${plan}/select`)
        .set('Authorization', `Bearer ${dispatcherToken()}`)
        .send({});

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_selected');
  });
});

// A solver run of its own, with the same three options the fixture's run has:
// one chosen with a full cost breakdown and two rejected with reason codes.
//
// A run with no options would still let a plan be SELECTED — the decision
// record would simply carry a null `selectedOptionId` — which is a silently
// weaker fixture than it looks. Every selection test here is really about the
// record that comes out, so the run it selects from has to have something to
// select.
async function freshRun(): Promise<string> {
  const run = await prismaBase.solverRun.create({
    data: {
      jobId: jobA,
      trigger: 'CONSOLE_TEST_RUN',
      snapshotHash: `hash-${Date.now()}-${Math.random()}`,
      optionCount: 3,
      feasibleCount: 1,
      wallClockMs: 1,
      zonePartitioned: false,
    },
    select: { id: true },
  });
  await writeOptions(run.id);
  return run.id;
}

// The plan variant for one label on the fixture's solver run, created lazily so
// each test gets a fresh row rather than sharing a selected one.
async function planVariant(label: string, solverRunId?: string): Promise<string> {
  const runId =
    solverRunId ??
    (
      await prismaBase.solverRun.findFirstOrThrow({
        where: { jobId: jobA, trigger: 'CONSOLE_TEST' },
        select: { id: true },
      })
    ).id;
  const created = await prismaBase.planVariant.create({
    data: {
      solverRunId: runId,
      jobId: jobA,
      label,
      assignments: [
        {
          jobId: jobA,
          unitId: `${PREFIX}-unit-good`,
          technicianId: `${PREFIX}-tech-good`,
          totalCost: 44.2,
        },
      ],
      metrics: { assignedCount: 1, unassignedCount: 0, unassignedJobIds: [] },
      totalCost: 44.2,
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// GET /degraded/payments — the drill-through behind the health banner.
//
// probePayments (src/health/probes.ts) has counted stuck authorisations since
// Phase 17 and the banner has shown the number; there was no way to find out
// WHICH. Invariant 8 asks that a degraded state be visible to an operator, and
// a count nobody can open only half satisfies it.
//
// The threshold is imported by the route from the probe, so these two cannot
// disagree about what "stuck" means. That is what the age assertion below is
// really checking: not the arithmetic, but that the route selects on the same
// boundary the banner counted on.

describe('GET /degraded/payments — which authorisations are stuck', () => {
  const PAY = `${PREFIX}-pay`;

  beforeAll(async () => {
    // One well past the ten-minute threshold, one comfortably inside it.
    await prismaBase.payment.createMany({
      data: [
        {
          jobId: jobA,
          method: 'CARD',
          status: 'PENDING_AUTHORISATION',
          amountPaise: 50_000,
          idempotencyKey: `${PAY}-stuck`,
          gatewayOrderRef: `order_${PAY}_stuck`,
          createdAt: new Date(Date.now() - 45 * 60_000),
        },
        {
          jobId: jobA,
          method: 'CARD',
          status: 'PENDING_AUTHORISATION',
          amountPaise: 25_000,
          idempotencyKey: `${PAY}-fresh`,
          createdAt: new Date(Date.now() - 60_000),
        },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prismaBase.payment.deleteMany({
      where: { idempotencyKey: { in: [`${PAY}-stuck`, `${PAY}-fresh`] } },
    });
  });

  it('lists the stuck authorisation and not the one still inside the window', async () => {
    const response = await request(app)
      .get('/degraded/payments')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);

    // SCOPED TO THIS FILE'S OWN ROWS. `zippy_test` is shared and other suites
    // write payments; asserting on the whole list would drift the moment one
    // of them ran alongside this.
    const mine = response.body.payments.filter(
      (payment: { jobId: string }) => payment.jobId === jobA,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ jobId: jobA, amount: '₹500' });
    expect(mine[0].waitingMinutes).toBeGreaterThanOrEqual(45);
    expect(mine[0].orderRef).toBe(`order_${PAY}_stuck`);
  });

  it('never exposes anything a card would be recognisable from', async () => {
    const response = await request(app)
      .get('/degraded/payments')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    // The card is typed into Razorpay's iframe and never reaches this database
    // (src/api/checkout.ts). This asserts the route did not go looking for
    // something adjacent — the shape is fixed and small on purpose.
    const keys = Object.keys(response.body.payments[0] ?? {}).sort();
    expect(keys).toEqual([
      'amount',
      'jobId',
      'jobStatus',
      'orderRef',
      'paymentId',
      'waitingMinutes',
      'zoneId',
    ]);
  });

  // The dispatcher's `payment: ['read']` grant is new in Phase 22b and is
  // deliberately read-only. A driver has full payment permission for their OWN
  // checkout, and this route is not scoped to a driver — so it must refuse
  // them rather than hand over the whole fleet's outstanding money.
  it('refuses a driver, who has payment permission only for their own checkout', async () => {
    const response = await request(app)
      .get('/degraded/payments')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get('/degraded/payments');
    expect(response.status).toBe(401);
  });
});
