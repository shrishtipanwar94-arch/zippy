// THE OFFLINE QUEUE — the phase check, written down.
//
//   "DevTools offline → four technician actions → online.
//    SELECT COUNT(*), COUNT(DISTINCT idempotency_key)
//      FROM technician_actions WHERE job_id='<id>';
//    -- both 4, applied in original order"
//
// That is exactly what the first test here asserts, over HTTP, against the
// real table. Then it does the thing the check cannot easily do by hand:
// replays the whole queue a second time, and asserts the counts are STILL four
// and the job did not move.
//
// SCOPED TO THIS FILE'S OWN JOBS. Every count is `WHERE job_id = <a job this
// test created>`, never a table total — `zippy_test` is shared by every suite
// and vitest runs files in parallel, so an assertion about the whole table
// drifts the moment another test writes. Scoping is also the stronger claim:
// counting rows that cannot exist unless this code created them proves
// something about this code, not about the database being quiet.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import type { LadderStep } from '../src/domain/jobLadder.js';

const app = createApp();
const PREFIX = 'techact';
const TENANT = `${PREFIX}-tenant`;

function technicianToken(technicianId = `${PREFIX}-tech`): string {
  return issueAccessToken({
    sub: `${PREFIX}-tech-user`,
    role: 'TECHNICIAN',
    tenantId: TENANT,
    crossTenant: false,
    actorId: technicianId,
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

// One queued tap, exactly as the phone would build it: a key minted at the tap,
// the phone's own counter, and the time the technician actually pressed the
// button — which during an outage is minutes before the server hears about it.
type QueuedAction = {
  idempotencyKey: string;
  step: LadderStep;
  clientSequence: number;
  eventTime: string;
  completionCode?: string;
};

function offlineQueue(jobId: string, tappedAt: Date): QueuedAction[] {
  return (['EN_ROUTE', 'ARRIVED', 'DIAGNOSING', 'WORKING'] as LadderStep[]).map((step, index) => ({
    idempotencyKey: `${jobId}-key-${index}`,
    step,
    clientSequence: index + 1,
    // Ninety seconds apart: the technician was working through this while the
    // phone had no signal.
    eventTime: new Date(tappedAt.getTime() + index * 90_000).toISOString(),
  }));
}

// The drain: strictly one at a time, in order, awaiting each. Firing them in
// parallel is the bug this shape exists to avoid.
async function drain(jobId: string, queue: QueuedAction[], token = technicianToken()) {
  const outcomes = [];
  for (const action of queue) {
    const response = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${token}`)
      .send(action);
    outcomes.push({ status: response.status, body: response.body });
  }
  return outcomes;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('four actions taken offline, then replayed', () => {
  const jobId = `${PREFIX}-job-replay`;

  it('applies all four, in the order they were tapped', async () => {
    await resetJob(jobId);
    const queue = offlineQueue(jobId, new Date('2026-08-31T10:00:00.000Z'));

    const outcomes = await drain(jobId, queue);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([200, 200, 200, 200]);
    expect(outcomes.map((outcome) => outcome.body.outcome)).toEqual([
      'APPLIED',
      'APPLIED',
      'APPLIED',
      'APPLIED',
    ]);

    // THE CHECK'S OWN QUERY, scoped to this job.
    const rows = await prismaBase.technicianAction.findMany({
      where: { jobId },
      orderBy: { receivedAt: 'asc' },
      select: { kind: true, idempotencyKey: true, clientSequence: true },
    });
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(4);
    // Applied in original order — the order the taps happened in, which is
    // what `client_sequence` records.
    expect(rows.map((row) => row.clientSequence)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.kind)).toEqual([
      'EN_ROUTE',
      'ARRIVED',
      'DIAGNOSING',
      'WORKING',
    ]);

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('WORKING');
  });

  // THE ONE THAT MATTERS. "Replaying twice must not double-transition
  // anything."
  it('replays the whole queue with no second transition', async () => {
    await resetJob(jobId);
    const queue = offlineQueue(jobId, new Date('2026-08-31T10:00:00.000Z'));

    await drain(jobId, queue);
    const afterFirst = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { version: true, status: true },
    });
    // job_events is append-only and the database trigger rejects a DELETE, so
    // this job's trail carries every earlier reset's events too. The claim is
    // about the REPLAY, so the baseline is taken here rather than assuming a
    // count — the same rule as scoping a count to rows the test created.
    const eventsAfterFirst = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'TECHNICIAN_ARRIVED' },
    });

    // The phone never got the responses and sends the whole queue again.
    const replay = await drain(jobId, queue);
    expect(replay.map((outcome) => outcome.body.outcome)).toEqual([
      'REPLAYED',
      'REPLAYED',
      'REPLAYED',
      'REPLAYED',
    ]);

    // Still four rows and four distinct keys — the second drain wrote nothing.
    const counted = await prismaBase.technicianAction.groupBy({
      by: ['jobId'],
      where: { jobId },
      _count: { _all: true },
    });
    expect(counted[0]?._count._all).toBe(4);

    const afterReplay = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { version: true, status: true },
    });
    // The version is the proof: an UPDATE that ran again would have bumped it.
    expect(afterReplay.version).toBe(afterFirst.version);
    expect(afterReplay.status).toBe(afterFirst.status);

    // And the append-only trail did not grow either: a replayed action writes
    // no event, because the event and the key are in the same transaction.
    const eventsAfterReplay = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'TECHNICIAN_ARRIVED' },
    });
    expect(eventsAfterReplay).toBe(eventsAfterFirst);
  });

  // The record is not the only defence. A DIFFERENT key for the same rung —
  // a second device, a reinstalled app, a phone whose storage was cleared —
  // gets past the unique index and is caught by the conditional UPDATE.
  it('refuses a repeated rung arriving under a fresh key', async () => {
    await resetJob(jobId);
    const queue = offlineQueue(jobId, new Date('2026-08-31T10:00:00.000Z'));
    await drain(jobId, queue);

    const response = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-second-device`,
        step: 'ARRIVED',
        clientSequence: 99,
        eventTime: new Date().toISOString(),
      });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('NO_CHANGE');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('WORKING');
  });

  // A dropped middle action must not strand the queue: the ladder advances
  // from any lower rung, so the next tap that does arrive closes the gap.
  it('survives an action that never arrived at all', async () => {
    const gapJob = `${PREFIX}-job-gap`;
    await resetJob(gapJob);

    const response = await request(app)
      .post(`/jobs/${gapJob}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${gapJob}-only-key`,
        step: 'WORKING',
        clientSequence: 4,
        eventTime: new Date().toISOString(),
      });

    expect(response.body.outcome).toBe('APPLIED');
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: gapJob },
      select: { status: true },
    });
    expect(job.status).toBe('WORKING');
  });
});

describe('the completion code', () => {
  const jobId = `${PREFIX}-job-code`;

  it('is issued on arrival and shown to the driver, not to the technician', async () => {
    await resetJob(jobId);

    await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-arrive`,
        step: 'ARRIVED',
        clientSequence: 1,
        eventTime: new Date().toISOString(),
      });

    const verification = await prismaBase.completionVerification.findUnique({
      where: { jobId },
      select: { code: true },
    });
    expect(verification?.code).toMatch(/^\d{6}$/);

    // The driver's own surface carries it. The technician's does not — that
    // is the whole point of a code.
    const driverView = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(driverView.body.completionCode.code.replace(' ', '')).toBe(verification?.code);

    const work = await request(app)
      .get('/technician/work')
      .set('Authorization', `Bearer ${technicianToken()}`);
    expect(JSON.stringify(work.body)).not.toContain(verification?.code);
  });

  it('refuses a wrong code without moving the job', async () => {
    const response = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-wrong`,
        step: 'COMPLETE',
        clientSequence: 2,
        eventTime: new Date().toISOString(),
        completionCode: '000000',
      });

    expect(response.body.outcome).toBe('REJECTED');
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true },
    });
    expect(job.status).toBe('ON_SITE');
  });

  // Replaying a rejected tap reproduces the rejection. An idempotency key
  // identifies one attempt; the technician's next try is a new tap with a new
  // key, which is why this does not lock them out.
  it('reproduces a rejection on replay, and accepts the retyped code', async () => {
    const replayed = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-wrong`,
        step: 'COMPLETE',
        clientSequence: 2,
        eventTime: new Date().toISOString(),
        completionCode: '000000',
      });
    expect(replayed.body.outcome).toBe('REPLAYED');
    expect(replayed.body.detail).toContain('does not match');

    const verification = await prismaBase.completionVerification.findUniqueOrThrow({
      where: { jobId },
      select: { code: true },
    });
    const accepted = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-right`,
        step: 'COMPLETE',
        clientSequence: 3,
        eventTime: new Date().toISOString(),
        // As the technician would type it, reading the driver's grouped code.
        completionCode: `${verification.code.slice(0, 3)} ${verification.code.slice(3)}`,
      });
    expect(accepted.body.outcome).toBe('APPLIED');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, resolvedAt: true },
    });
    expect(job.status).toBe('RESOLVED');
    expect(job.resolvedAt).not.toBeNull();
  });

  it('will not complete a job that was never arrived at', async () => {
    const bareJob = `${PREFIX}-job-nocode`;
    await resetJob(bareJob);

    const response = await request(app)
      .post(`/jobs/${bareJob}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${bareJob}-complete`,
        step: 'COMPLETE',
        clientSequence: 1,
        eventTime: new Date().toISOString(),
        completionCode: '123456',
      });
    expect(response.body.outcome).toBe('REJECTED');
    expect(response.body.detail).toContain('on scene');
  });
});

describe('who may act', () => {
  // A DRIVER may `read` `job` — that is how they see their own incident — so
  // the technician's board is gated on its own resource. Guarding it on `job`
  // gave a driver an empty 200 on somebody else's surface.
  it('keeps a driver off the technician board entirely', async () => {
    const response = await request(app)
      .get('/technician/work')
      .set('Authorization', `Bearer ${driverToken()}`);
    expect(response.status).toBe(403);
  });

  it('refuses a driver', async () => {
    const response = await request(app)
      .post(`/jobs/${PREFIX}-job-replay/actions`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({
        idempotencyKey: 'driver-attempt',
        step: 'ARRIVED',
        clientSequence: 1,
        eventTime: new Date().toISOString(),
      });
    expect(response.status).toBe(403);
  });

  // A technician released while offline. Their queued actions must not move a
  // job that is now somebody else's, and they must be told why rather than
  // watching a silent no-op.
  it('refuses a technician the job has been taken from', async () => {
    const jobId = `${PREFIX}-job-released`;
    await resetJob(jobId);
    await prismaBase.job.update({
      where: { id: jobId },
      data: { assignedTechnicianId: `${PREFIX}-other-tech` },
    });

    const response = await request(app)
      .post(`/jobs/${jobId}/actions`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({
        idempotencyKey: `${jobId}-stale`,
        step: 'ARRIVED',
        clientSequence: 1,
        eventTime: new Date().toISOString(),
      });

    expect(response.body.outcome).toBe('REJECTED');
    expect(response.body.detail).toContain('no longer assigned to you');
  });
});

// ---------------------------------------------------------------------------

// Puts one job back at COMMITTED with a clean slate, so each test starts from
// the same rung. Only rows belonging to THIS job are removed.
async function resetJob(jobId: string): Promise<void> {
  await prismaBase.technicianAction.deleteMany({ where: { jobId } });
  await prismaBase.completionVerification.deleteMany({ where: { jobId } });
  // job_events is append-only and the database trigger rejects a DELETE, so
  // the trail simply accumulates across resets — which is why the assertions
  // above count one event TYPE on a freshly reset job rather than the total.
  await prismaBase.job.update({
    where: { id: jobId },
    data: {
      status: 'COMMITTED',
      resolvedAt: null,
      assignedUnitId: `${PREFIX}-unit`,
      assignedTechnicianId: `${PREFIX}-tech`,
    },
  });
}

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Technician Action Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'TAC',
      name: 'Technician Action Zone',
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
      make: 'Maruti Suzuki',
      model: 'Swift',
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
      registration: 'DL01TA0001',
      colour: 'Red',
    },
  });

  for (const suffix of ['tech', 'other-tech']) {
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-${suffix}-user` },
      update: {},
      create: {
        id: `${PREFIX}-${suffix}-user`,
        email: `${PREFIX}-${suffix}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: 'Asha Rao',
      },
    });
    await prismaBase.technician.upsert({
      where: { id: `${PREFIX}-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-${suffix}`,
        userId: `${PREFIX}-${suffix}-user`,
        employeeCode: `${PREFIX}-${suffix}`,
        homeZoneId: `${PREFIX}-zone`,
      },
    });
  }

  await prismaBase.unit.upsert({
    where: { id: `${PREFIX}-unit` },
    update: {},
    create: {
      id: `${PREFIX}-unit`,
      code: 'TAC-VAN-1',
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'ON_JOB',
      lat: 28.62,
      lng: 77.205,
    },
  });

  for (const suffix of ['replay', 'gap', 'code', 'nocode', 'released']) {
    await prismaBase.job.upsert({
      where: { id: `${PREFIX}-job-${suffix}` },
      update: {},
      create: {
        id: `${PREFIX}-job-${suffix}`,
        tenantId: TENANT,
        driverId: `${PREFIX}-driver`,
        vehicleId: `${PREFIX}-vehicle`,
        zoneId: `${PREFIX}-zone`,
        status: 'COMMITTED',
        safetyLevel: 'NORMAL',
        assignedUnitId: `${PREFIX}-unit`,
        assignedTechnicianId: `${PREFIX}-tech`,
        lat: 28.6152,
        lng: 77.2095,
        roadPosition: 'SERVICE_ROAD',
      },
    });
  }
}
