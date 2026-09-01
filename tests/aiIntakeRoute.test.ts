// PHASE 16 OVER HTTP, against the real `zippy_test` Postgres, WITH NO API KEY.
//
// That last part is the whole point of this file. The fast suite runs without
// LLM_API_KEY set, so every request here takes the degraded path — which means
// this suite is a standing proof of invariant 8: with the model gone, describe
// still answers, intake still creates a job, the symptom report still stores
// what the driver said, and the operator can see that the extractor is down.
// If the AI ever becomes load-bearing, these tests are what goes red.
//
// SCOPED ASSERTIONS ONLY. Every row this file looks at is one it created and
// can name — its own extraction ids, its own job id. `zippy_test` is shared and
// vitest runs files in parallel, so anything phrased about the whole table
// would drift the moment another suite wrote to it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { AI_COMPONENT } from '../src/ai/health.js';

const app = createApp();
const TENANT = 'air-tenant';
const ZONE = 'air-zone';

function driverToken(): string {
  return issueAccessToken({
    sub: 'air-driver-user',
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: 'air-driver',
  });
}

function describeRequest(text: string) {
  return request(app)
    .post('/jobs/intake/describe')
    .set('Authorization', `Bearer ${driverToken()}`)
    .send({ text });
}

function intake(body: Record<string, unknown>) {
  return request(app)
    .post('/jobs/intake')
    .set('Authorization', `Bearer ${driverToken()}`)
    .send({
      vehicleId: 'air-vehicle',
      location: { lat: 12.9352, lng: 77.6245, roadPosition: 'PARKING' },
      ...body,
    });
}

describe('POST /jobs/intake/describe with no model configured', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('answers 200 with a degraded flag rather than failing the request', async () => {
    const response = await describeRequest('air-case-1 gaadi start nahi ho rahi');

    expect(response.status).toBe(200);
    expect(response.body.degraded).toBe(true);
    expect(response.body.reason).toBe('NOT_CONFIGURED');
    expect(response.body.symptoms).toBeNull();
  });

  it('writes the failed attempt down — the denominator of every rate', async () => {
    const text = 'air-case-2 dashboard pe battery ka light';
    await describeRequest(text);

    const row = await prismaBase.aiExtraction.findFirst({
      where: { prompt: text },
      select: { extracted: true, rawResponse: true, confidence: true },
    });

    expect(row).not.toBeNull();
    expect(row?.extracted).toBeNull();
    expect(row?.confidence).toBeNull();
    expect((row?.rawResponse as { status?: string })?.status).toBe('FALLBACK');
  });

  it('makes the degraded state visible to an operator', async () => {
    await describeRequest('air-case-3 tyre punctured hai');

    const health = await prismaBase.systemHealthState.findUnique({
      where: { component: AI_COMPONENT },
      select: { state: true, detail: true },
    });

    expect(health?.state).toBe('DEGRADED');
    expect(health?.detail).toContain('NOT_CONFIGURED');

    // Phase 17 replaced the single `ai` field with the whole degradation
    // ladder. The claim is unchanged — an operator can see it from /health —
    // and the row it is read from is the same one.
    const probe = await request(app).get('/health');
    const ai = probe.body.components.find(
      (component: { component: string }) => component.component === 'AI_EXTRACTION',
    );
    expect(ai.state).toBe('DEGRADED');
    expect(ai.fallback).toContain('symptom picker');
  });
});

describe('intake still works end to end with the model down', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('creates a job from the picker payload and keeps what the driver typed', async () => {
    const response = await intake({
      symptoms: { primaryComplaint: 'FLAT_TYRE' },
      rawText: 'air-raw tyre phat gaya hai',
    });

    expect(response.status).toBe(201);

    const report = await prismaBase.symptomReport.findFirstOrThrow({
      where: { jobId: response.body.jobId },
      select: { source: true, rawText: true },
    });

    // No extraction id, so this is the Phase 3 path exactly — the raw text is
    // stored because the driver said it, not because a model read it.
    expect(report.source).toBe('STRUCTURED');
    expect(report.rawText).toBe('air-raw tyre phat gaya hai');
  });

  it('links a confirmed extraction to the job and records that nothing was changed', async () => {
    const extraction = await seedExtraction({ primaryComplaint: 'WONT_START', warningLights: ['BATTERY'] });

    const response = await intake({
      symptoms: { primaryComplaint: 'WONT_START', warningLights: ['BATTERY'] },
      extractionId: extraction,
    });
    expect(response.status).toBe(201);

    const row = await prismaBase.aiExtraction.findUniqueOrThrow({
      where: { id: extraction },
      select: { jobId: true, accepted: true },
    });
    expect(row.jobId).toBe(response.body.jobId);
    expect(row.accepted).toBe(true);

    const report = await prismaBase.symptomReport.findFirstOrThrow({
      where: { jobId: response.body.jobId },
      select: { source: true },
    });
    expect(report.source).toBe('AI_ASSISTED');
  });

  it('records a correction when the driver changed what was read', async () => {
    const extraction = await seedExtraction({ primaryComplaint: 'WONT_START', warningLights: [] });

    const response = await intake({
      symptoms: { primaryComplaint: 'FLAT_TYRE' },
      extractionId: extraction,
    });
    expect(response.status).toBe(201);

    const row = await prismaBase.aiExtraction.findUniqueOrThrow({
      where: { id: extraction },
      select: { accepted: true },
    });
    // The driver overruled the model. The job is built from what they said,
    // and the disagreement is the number worth having.
    expect(row.accepted).toBe(false);
  });

  it('ignores an extraction id that is already claimed by another job', async () => {
    const extraction = await seedExtraction({ primaryComplaint: 'FLAT_TYRE', warningLights: [] });

    const first = await intake({ symptoms: { primaryComplaint: 'FLAT_TYRE' }, extractionId: extraction });
    const second = await intake({ symptoms: { primaryComplaint: 'FLAT_TYRE' }, extractionId: extraction });

    expect(second.status).toBe(201);
    const row = await prismaBase.aiExtraction.findUniqueOrThrow({
      where: { id: extraction },
      select: { jobId: true },
    });
    expect(row.jobId).toBe(first.body.jobId);
  });
});

// A stored extraction, as /describe would have written one had the model
// answered. Written directly because this suite has no key — what is under
// test here is the linking, not the extractor.
async function seedExtraction(symptoms: Record<string, unknown>): Promise<string> {
  const row = await prismaBase.aiExtraction.create({
    data: {
      model: 'test-model',
      prompt: 'air-seeded',
      extracted: {
        symptoms: { engineCranks: null, unusualSound: null, vehicleMoves: null, warningLights: [], ...symptoms },
      },
      confidence: 0.5,
    },
    select: { id: true },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Upserted, never torn down: `job_events` is append-only, so a job that has
// events cannot be deleted.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'AI Route Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'AIRZ',
      name: 'AI Route Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: 'air-profile' },
    update: {},
    create: {
      id: 'air-profile',
      // Distinct from every other suite: the unique key is
      // (make, model, yearFrom, yearTo) and the suites share one database.
      make: 'TEST_AI_ROUTE',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: 'air-driver-user' },
    update: {},
    create: {
      id: 'air-driver-user',
      email: 'air-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'AI Route Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: 'air-driver' },
    update: {},
    create: { id: 'air-driver', userId: 'air-driver-user', tenantId: TENANT, homeZoneId: ZONE },
  });
  await prismaBase.vehicle.upsert({
    where: { id: 'air-vehicle' },
    update: {},
    create: {
      id: 'air-vehicle',
      driverId: 'air-driver',
      tenantId: TENANT,
      profileId: 'air-profile',
      registration: 'AIR1AB0001',
      colour: 'White',
    },
  });
}
