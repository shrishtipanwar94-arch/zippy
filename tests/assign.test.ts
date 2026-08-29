// PATCH /jobs/:id/assign — the Phase 4 manual placeholder.
//
// Two things are worth testing on a placeholder that is going to be deleted:
// that only a DISPATCHER can reach it, and that it does not break invariant 7
// (one active job per unit) on the way past. Everything else about it is
// deliberately absent and Phase 9's job.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { assignUnitToJob, AssignmentError } from '../src/commit/assignUnit.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import { symptomPayloadSchema } from '../src/domain/symptoms.js';
import { safetyReportSchema } from '../src/domain/safety.js';
import { locationSchema } from '../src/domain/location.js';

const app = createApp();
const TENANT = 'as-tenant';
const ZONE = 'as-zone';

function token(role: 'DISPATCHER' | 'TECHNICIAN' | 'FLEET_MANAGER' | 'DRIVER'): string {
  return issueAccessToken({
    sub: `as-${role.toLowerCase()}-user`,
    role,
    tenantId: role === 'DISPATCHER' ? null : TENANT,
    crossTenant: role === 'DISPATCHER',
    actorId: role === 'DRIVER' ? 'as-driver' : undefined,
  });
}

async function newJob(): Promise<string> {
  const created = await createIntakeJob(prismaBase, {
    driverId: 'as-driver',
    vehicleId: 'as-vehicle',
    tenantId: TENANT,
    symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'FLAT_TYRE' }),
    safety: safetyReportSchema.parse({}),
    location: locationSchema.parse({ lat: 12.9352, lng: 77.6245, roadPosition: 'PARKING' }),
    actor: { role: 'DRIVER', id: 'as-driver-user' },
    at: new Date('2026-06-01T09:00:00Z'),
  });
  return created.jobId;
}

// A NEW UNIT PER RUN, never a reused one reset to AVAILABLE.
//
// The first version of this upserted `as-unit-a` and friends and set them back
// to AVAILABLE at the start of each run. That looked like tidy fixture reuse
// and was actually manufacturing the exact state invariant 7 forbids: the jobs
// from previous runs still pointed at those units and cannot be deleted
// (`job_events` is append-only), so after five runs one unit was held by five
// jobs. The suite then failed on its own leftovers rather than on the code.
// Run-scoped ids keep every run's units genuinely fresh.
const RUN = Math.random().toString(36).slice(2, 8);

async function freshUnit(suffix: string): Promise<string> {
  const id = `as-unit-${RUN}-${suffix}`;
  await prismaBase.unit.create({
    data: { id, code: `ASU-${RUN}-${suffix}`, kind: 'VAN', zoneId: ZONE, status: 'AVAILABLE' },
  });
  return id;
}

describe('PATCH /jobs/:id/assign', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('lets a dispatcher assign an available unit', async () => {
    const jobId = await newJob();
    const unitId = await freshUnit('a');

    const response = await request(app)
      .patch(`/jobs/${jobId}/assign`)
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({ unitId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jobId, unitId });

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { assignedUnitId: true, status: true },
    });
    expect(job.assignedUnitId).toBe(unitId);
    expect(job.status).toBe('PLANNED');

    const unit = await prismaBase.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { status: true },
    });
    expect(unit.status).toBe('ON_JOB');
  });

  // A TECHNICIAN has `update` on `job` — they progress their own work — and
  // that must not extend to deciding who gets sent. This is why assignment is
  // its own resource in the permission table rather than a role check in the
  // handler.
  it('refuses every role except DISPATCHER', async () => {
    const jobId = await newJob();
    const unitId = await freshUnit('b');

    for (const role of ['TECHNICIAN', 'FLEET_MANAGER', 'DRIVER'] as const) {
      const response = await request(app)
        .patch(`/jobs/${jobId}/assign`)
        .set('Authorization', `Bearer ${token(role)}`)
        .send({ unitId });

      expect(response.status, role).toBe(403);
    }

    const unit = await prismaBase.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { status: true },
    });
    expect(unit.status).toBe('AVAILABLE');
  });

  it('refuses an unauthenticated caller', async () => {
    const jobId = await newJob();
    const response = await request(app).patch(`/jobs/${jobId}/assign`).send({ unitId: 'x' });

    expect(response.status).toBe(401);
  });

  // INVARIANT 7 — one active job per unit. The second assignment must lose.
  it('will not put one unit on two jobs', async () => {
    const firstJob = await newJob();
    const secondJob = await newJob();
    const unitId = await freshUnit('c');

    const first = await request(app)
      .patch(`/jobs/${firstJob}/assign`)
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({ unitId });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/jobs/${secondJob}/assign`)
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({ unitId });

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('unit_not_available');

    const stillFree = await prismaBase.job.findUniqueOrThrow({
      where: { id: secondJob },
      select: { assignedUnitId: true, status: true },
    });
    expect(stillFree.assignedUnitId).toBeNull();
    expect(stillFree.status).toBe('INTAKE');
  });

  // The same invariant under a real race rather than in sequence. Both callers
  // read the unit as AVAILABLE; the conditional UPDATE is what separates them.
  it('survives two dispatchers assigning the same unit at the same moment', async () => {
    const jobA = await newJob();
    const jobB = await newJob();
    const unitId = await freshUnit('d');

    const actor = { role: 'DISPATCHER', id: 'as-dispatcher-user' };
    const results = await Promise.allSettled([
      assignUnitToJob(prismaBase, { jobId: jobA, unitId, actor }),
      assignUnitToJob(prismaBase, { jobId: jobB, unitId, actor }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AssignmentError);
    expect(['LOST_RACE', 'UNIT_NOT_AVAILABLE']).toContain((reason as AssignmentError).code);

    // And exactly one job actually holds it.
    const holders = await prismaBase.job.count({ where: { assignedUnitId: unitId } });
    expect(holders).toBe(1);
  });

  it('404s a job the caller cannot see, before touching the unit', async () => {
    const unitId = await freshUnit('e');
    const response = await request(app)
      .patch('/jobs/does-not-exist/assign')
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({ unitId });

    expect(response.status).toBe(404);

    const unit = await prismaBase.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { status: true },
    });
    expect(unit.status).toBe('AVAILABLE');
  });

  it('rejects an unknown unit and a malformed body', async () => {
    const jobId = await newJob();
    const dispatcher = `Bearer ${token('DISPATCHER')}`;

    const unknown = await request(app)
      .patch(`/jobs/${jobId}/assign`)
      .set('Authorization', dispatcher)
      .send({ unitId: 'as-unit-nonexistent' });
    expect(unknown.status).toBe(404);

    const malformed = await request(app)
      .patch(`/jobs/${jobId}/assign`)
      .set('Authorization', dispatcher)
      .send({ unit: 'wrong-key' });
    expect(malformed.status).toBe(400);
  });

  it('writes a UNIT_ASSIGNED event so the other surfaces see it', async () => {
    const jobId = await newJob();
    const unitId = await freshUnit('f');

    await request(app)
      .patch(`/jobs/${jobId}/assign`)
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({ unitId });

    const events = await prismaBase.jobEvent.findMany({
      where: { jobId, eventType: 'UNIT_ASSIGNED' },
      select: { payload: true, actorRole: true },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actorRole).toBe('DISPATCHER');
    expect(events[0]?.payload).toMatchObject({ unitId, source: 'MANUAL_DISPATCHER_PICK' });
  });
});

// ---------------------------------------------------------------------------
// Upserted, never torn down: `job_events` is append-only, so a job that has
// events cannot be deleted.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Assign Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'ASZ',
      name: 'Assign Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: 'as-profile' },
    update: {},
    create: {
      id: 'as-profile',
      make: 'TEST_ASSIGN',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: 'as-driver-user' },
    update: {},
    create: {
      id: 'as-driver-user',
      email: 'as-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Assign Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: 'as-driver' },
    update: {},
    create: { id: 'as-driver', userId: 'as-driver-user', tenantId: TENANT, homeZoneId: ZONE },
  });
  await prismaBase.vehicle.upsert({
    where: { id: 'as-vehicle' },
    update: {},
    create: {
      id: 'as-vehicle',
      driverId: 'as-driver',
      tenantId: TENANT,
      profileId: 'as-profile',
      registration: 'AS01AB0001',
      colour: 'White',
    },
  });
}
