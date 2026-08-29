// POST /jobs/intake over HTTP, against the real `zippy_test` Postgres.
//
// This file exists because of a bug a pure test could not have caught. Safety
// triage was correct, the location schema was correct, and every unit test
// passed — but the ROUTE never connected them, so a highway breakdown was
// stored with `on_highway = true` and a safety level of NORMAL. The defect
// lived in the wiring between two correct pieces, which is exactly what an
// integration test is for.
//
// The assertions below all send NO safety information whatsoever. That is the
// point: the caller states where it is, and the server decides how dangerous
// that is.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';

const app = createApp();
const TENANT = 'ir-tenant';
const ZONE = 'ir-zone';

function driverToken(): string {
  return issueAccessToken({
    sub: 'ir-driver-user',
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: 'ir-driver',
  });
}

function report(location: Record<string, unknown>) {
  return request(app)
    .post('/jobs/intake')
    .set('Authorization', `Bearer ${driverToken()}`)
    .send({
      vehicleId: 'ir-vehicle',
      symptoms: { primaryComplaint: 'FLAT_TYRE' },
      // NO `safety` key at all.
      location: { lat: 12.9352, lng: 77.6245, ...location },
    });
}

describe('POST /jobs/intake — safety derives from where the vehicle is', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('triages a highway shoulder above NORMAL with no safety field sent', async () => {
    const response = await report({ roadPosition: 'SHOULDER' });

    expect(response.status).toBe(201);
    expect(response.body.safetyLevel).not.toBe('NORMAL');
    expect(response.body.safetyReasonCodes).toContain('ON_HIGHWAY');
  });

  // ELEVATED, not HIGH_RISK: `blockingLiveLane` is still a separate field the
  // caller states, and nothing here states it. See the note at the foot of this
  // file — that is arguably the same duplication as `onHighway`, left alone
  // deliberately rather than changed in passing.
  it('triages a traffic lane above NORMAL with no safety field sent', async () => {
    const response = await report({ roadPosition: 'LANE' });

    expect(response.status).toBe(201);
    expect(response.body.safetyLevel).toBe('ELEVATED');
    expect(response.body.safetyReasonCodes).toContain('ON_HIGHWAY');
  });

  it('leaves a car park NORMAL on the same empty input', async () => {
    const response = await report({ roadPosition: 'PARKING' });

    expect(response.status).toBe(201);
    expect(response.body.safetyLevel).toBe('NORMAL');
    expect(response.body.safetyReasonCodes).toEqual([]);
  });

  // The stored column and the safety level come from ONE derivation, so they
  // cannot disagree. Before the fix this job had on_highway = true and
  // safety_level = NORMAL at the same time.
  it('stores a location and a safety level that agree', async () => {
    const response = await report({ roadPosition: 'SHOULDER' });
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: response.body.jobId },
      select: { onHighway: true, safetyLevel: true, roadPosition: true },
    });

    expect(job.roadPosition).toBe('SHOULDER');
    expect(job.onHighway).toBe(true);
    expect(job.safetyLevel).not.toBe('NORMAL');
  });

  // FAIL CLOSED, end to end. The caller sends a location with no road position
  // and no safety block at all, and the job still comes back raised.
  it('triages a report with no road position as ELEVATED', async () => {
    const response = await report({});

    expect(response.status).toBe(201);
    expect(response.body.safetyLevel).toBe('ELEVATED');
    expect(response.body.safetyReasonCodes).toContain('UNKNOWN_POSITION');
  });

  it('rejects a caller that tries to set onHighway itself', async () => {
    const response = await report({ roadPosition: 'PARKING', onHighway: true });

    // Strict schemas: an unknown key is a 400, not a silent strip. A client
    // that believes it is setting something must not be quietly ignored.
    expect(response.status).toBe(400);
  });

  it('rejects a caller that tries to declare its own safety level inputs', async () => {
    const response = await request(app)
      .post('/jobs/intake')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({
        vehicleId: 'ir-vehicle',
        symptoms: { primaryComplaint: 'FLAT_TYRE' },
        safety: { onHighway: true, night: true },
        location: { lat: 12.9352, lng: 77.6245, roadPosition: 'PARKING' },
      });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Upserted, never torn down: `job_events` is append-only, so a job that has
// events cannot be deleted. Assertions are scoped to the job each test creates.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Intake Route Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'IRZ',
      name: 'Intake Route Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: 'ir-profile' },
    update: {},
    create: {
      id: 'ir-profile',
      // Distinct from every other suite: the unique key is
      // (make, model, yearFrom, yearTo) and the suites share one database.
      make: 'TEST_INTAKE_ROUTE',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: 'ir-driver-user' },
    update: {},
    create: {
      id: 'ir-driver-user',
      email: 'ir-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Intake Route Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: 'ir-driver' },
    update: {},
    create: { id: 'ir-driver', userId: 'ir-driver-user', tenantId: TENANT, homeZoneId: ZONE },
  });
  await prismaBase.vehicle.upsert({
    where: { id: 'ir-vehicle' },
    update: {},
    create: {
      id: 'ir-vehicle',
      driverId: 'ir-driver',
      tenantId: TENANT,
      profileId: 'ir-profile',
      registration: 'IR01AB0001',
      colour: 'White',
    },
  });
}

// ---------------------------------------------------------------------------
// `roadPosition: 'LANE'` and `safety.blockingLiveLane` resemble the `onHighway`
// duplication and are NOT it. Road position is geometry — where the vehicle is
// standing; blocking is context — whether that position is obstructing moving
// traffic. A car stopped in a lane of an empty road at 3am is in a lane and is
// blocking nobody. They stay separate deliberately; the reasoning lives at the
// rule itself in src/domain/safety.ts.
