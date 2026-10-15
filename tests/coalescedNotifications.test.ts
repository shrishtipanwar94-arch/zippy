// ONE MESSAGE PER RE-PLAN — the brief's third "do not".
//
//   "A re-plan can fire six events in ninety seconds. The driver receives ONE
//    message, after the plan stabilises, not mid-flight."
//
// There are two separable claims there and this file tests both, in the two
// places they actually live:
//
//   1. COLLAPSING. Many triggers in a window produce one queued job. That is
//      the debounce helper, already proved against a real Redis in
//      tests/queues.test.ts — so what is asserted here is that the notification
//      path USES it, keyed on the job, rather than enqueueing per trigger.
//
//   2. DESCRIBING THE SETTLED STATE. The message body is composed when the
//      queued job FIRES, from the job as it then is — not from the event that
//      triggered it. This is the half that makes the coalescing correct rather
//      than merely quiet: picking one of the six events would describe a moment
//      that may already be false. It runs without Redis, because the composing
//      is a pure function of a database row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaBase } from '../src/infra/prismaBase.js';
import { processNotification } from '../src/workers/notification.js';
import { headlineFor } from '../src/domain/driverNarrative.js';
import type { Job } from 'bullmq';

const PREFIX = 'coalesce';
const TENANT = `${PREFIX}-tenant`;
const JOB_ID = `${PREFIX}-job`;

// The worker takes a BullMQ Job. Only three fields are read — id, data and
// log — so a stand-in is honest here and means this test needs no broker.
function queuedJob(id: string, data: unknown): Job {
  return { id, data, log: async () => 0 } as unknown as Job;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('the notification path collapses a re-plan storm', () => {
  const source = readFileSync(join('src', 'workers', 'notification.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('enqueues through the debounce helper, not straight onto the queue', () => {
    expect(source).toMatch(/enqueueDebounced\(/);
    // A bare `queues.notification.add(` would be one job per trigger — exactly
    // the six messages the brief forbids.
    expect(source).not.toMatch(/queues\.notification\.add\(/);
  });

  it('keys the window on the job, so two triggers for one job are one message', () => {
    expect(source).toMatch(/job:\$\{jobId\}:replan/);
  });
});

describe('the message describes where the job ended up', () => {
  it('is composed from the job at delivery time, not from the trigger', async () => {
    // The job is mid-re-plan when the trigger fires...
    await prismaBase.job.update({
      where: { id: JOB_ID },
      data: { status: 'PLANNED', assignedTechnicianId: null },
    });

    // ...and has settled on a new crew by the time the queued job runs.
    await prismaBase.job.update({
      where: { id: JOB_ID },
      data: { status: 'COMMITTED', assignedTechnicianId: `${PREFIX}-tech` },
    });

    await processNotification(
      queuedJob(`${PREFIX}-run-1`, { jobId: JOB_ID, reason: 'reassignment:test' }),
    );

    const notifications = await prismaBase.notification.findMany({
      where: { jobId: JOB_ID },
      select: { body: true, coalesceKey: true, recipientId: true, sentAt: true },
    });

    expect(notifications).toHaveLength(1);
    // The settled state — a named technician on the way — not "we are finding
    // someone", which is what the trigger moment would have said.
    expect(notifications[0]?.body).toContain('Priya');
    expect(notifications[0]?.recipientId).toBe(`${PREFIX}-driver-user`);
    // Stored as well as used for the debounce, so "why one message and not
    // six?" is answerable from the table afterwards.
    expect(notifications[0]?.coalesceKey).toBe(`job:${JOB_ID}:replan`);
  });

  it('says the same thing the driver’s own page says', async () => {
    const notification = await prismaBase.notification.findFirstOrThrow({
      where: { jobId: JOB_ID },
      select: { body: true },
    });

    // Same translation map as the live panel (src/domain/driverNarrative.ts),
    // so a notification can never contradict the screen it points at.
    expect(notification.body).toBe(
      headlineFor({
        status: 'COMMITTED',
        helperName: 'Priya',
        arrivingAt: null,
        replanning: false,
        sourcingPart: false,
        intakeComplete: true,
      }),
    );
  });

  // The queue delivers at least once: a worker can crash after finishing the
  // work but before acknowledging it, and the job is redelivered. A second
  // copy of a message whose entire purpose was to be the only one is the worst
  // possible thing for this particular queue to get wrong.
  it('writes nothing on a redelivery of the same queued job', async () => {
    await processNotification(
      queuedJob(`${PREFIX}-run-1`, { jobId: JOB_ID, reason: 'reassignment:test' }),
    );

    expect(await prismaBase.notification.count({ where: { jobId: JOB_ID } })).toBe(1);
  });

  it('ignores a queued job with nothing to say', async () => {
    await processNotification(queuedJob(`${PREFIX}-run-empty`, {}));
    expect(await prismaBase.notification.count({ where: { jobId: JOB_ID } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Coalesce Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'CLS',
      name: 'Coalesce Zone',
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
      // DISTINCT ON PURPOSE. `vehicle_profiles` has a unique on
      // (make, model, year_from, year_to), and `zippy_test` is shared — two
      // fixtures both reaching for a real-sounding car collide on that natural
      // key. A fixture that OWNS a row must name it so nothing else can.
      make: 'Coalesce Motors',
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
      registration: 'DL01CL0001',
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
      name: 'Priya Nair',
    },
  });
  await prismaBase.technician.upsert({
    where: { id: `${PREFIX}-tech` },
    update: {},
    create: {
      id: `${PREFIX}-tech`,
      userId: `${PREFIX}-tech-user`,
      employeeCode: `${PREFIX}-T1`,
      homeZoneId: `${PREFIX}-zone`,
    },
  });
  await prismaBase.job.upsert({
    where: { id: JOB_ID },
    update: { status: 'COMMITTED', assignedTechnicianId: `${PREFIX}-tech` },
    create: {
      id: JOB_ID,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'COMMITTED',
      safetyLevel: 'NORMAL',
      assignedTechnicianId: `${PREFIX}-tech`,
      lat: 28.6152,
      lng: 77.2095,
    },
  });

  // This file owns its notifications and its idempotency rows, so both are
  // cleared rather than accumulated — the counts above are about one run.
  await prismaBase.notification.deleteMany({ where: { jobId: JOB_ID } });
  await prismaBase.jobProcessingLog.deleteMany({
    where: { queue: 'notification', idempotencyKey: { startsWith: `${PREFIX}-run-` } },
  });
}
