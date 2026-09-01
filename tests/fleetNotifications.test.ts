// PHASE 21 — fleet notifications use a WIDER coalescing window than a
// driver's and reach every FLEET_MANAGER on the tenant, not one recipient.
//
// SAME SHAPE AS tests/coalescedNotifications.test.ts, on purpose: both files
// prove the identical two claims — collapsing via the debounce helper, and
// composing the message from the job's SETTLED state at delivery time — for
// the two different audiences that mechanism now serves. A source-text scan
// checks the window is actually different rather than a copy-pasted number;
// everything else runs `processNotification` directly against a real row, the
// same way the driver suite does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaBase } from '../src/infra/prismaBase.js';
import { processNotification } from '../src/workers/notification.js';
import type { Job } from 'bullmq';

const PREFIX = 'fleetnotify';
const TENANT = `${PREFIX}-tenant`;
const JOB_ID = `${PREFIX}-job`;
const WALKIN_JOB_ID = `${PREFIX}-walkin-job`;

// The worker takes a BullMQ Job. Four fields are read — id, name, data, log —
// so a stand-in naming all four is honest and needs no broker.
function queuedJob(id: string, name: string, data: unknown): Job {
  return { id, name, data, log: async () => 0 } as unknown as Job;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('the fleet notification path uses its own, wider window', () => {
  const source = readFileSync(join('src', 'workers', 'notification.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('enqueues under its own job name and coalesce key, not the driver’s', () => {
    expect(source).toMatch(/'fleet-state-change'/);
    expect(source).toMatch(/job:\$\{jobId\}:fleet-state-change/);
  });

  it('coalesces over a longer window than the driver path', () => {
    // Evaluates the constant's own source expression (`10 * 60_000`, etc.)
    // rather than trying to out-guess arbitrary arithmetic with a regex.
    const evaluate = (name: string): number => {
      const expression = new RegExp(`${name} = ([^;]+);`).exec(source)?.[1];
      if (!expression) throw new Error(`could not find ${name} in notification.ts`);
      // eslint-disable-next-line no-new-func -- reading a numeric literal expression out of our own source file, in a test
      return Function(`return (${expression.replace(/_/g, '')});`)() as number;
    };

    expect(evaluate('FLEET_STATE_CHANGE_COALESCE_MS')).toBeGreaterThan(evaluate('REPLAN_COALESCE_MS'));
  });
});

describe('delivering a fleet state-change notification', () => {
  it('writes one row per FLEET_MANAGER on the tenant, worded from the settled state', async () => {
    await processNotification(
      queuedJob(`${PREFIX}-run-1`, 'fleet-state-change', {
        jobId: JOB_ID,
        reason: 'reassignment:test',
      }),
    );

    const notifications = await prismaBase.notification.findMany({
      where: { jobId: JOB_ID },
      select: { recipientId: true, body: true, coalesceKey: true, title: true },
    });

    // Two fleet managers on this tenant in the fixture below.
    expect(notifications).toHaveLength(2);
    const recipients = notifications.map((n) => n.recipientId).sort();
    expect(recipients).toEqual([`${PREFIX}-fm-a-user`, `${PREFIX}-fm-b-user`].sort());

    for (const notification of notifications) {
      expect(notification.body).toContain('KA01FN0001');
      expect(notification.coalesceKey).toBe(`job:${JOB_ID}:fleet-state-change`);
      expect(notification.title).toBe('Fleet update');
    }
  });

  it('describes the state the job is in NOW, not the trigger that started the wait', async () => {
    // Settle the job somewhere the trigger never mentioned.
    await prismaBase.job.update({ where: { id: JOB_ID }, data: { status: 'ON_SITE' } });

    await processNotification(
      queuedJob(`${PREFIX}-run-2`, 'fleet-state-change', {
        jobId: JOB_ID,
        reason: 'reassignment:test',
      }),
    );

    const latest = await prismaBase.notification.findFirst({
      where: { jobId: JOB_ID, recipientId: `${PREFIX}-fm-a-user` },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });
    expect(latest?.body).toContain('on site');
  });

  it('is idempotent on the queue job id, the same as the driver path', async () => {
    const before = await prismaBase.notification.count({ where: { jobId: JOB_ID } });
    await processNotification(
      queuedJob(`${PREFIX}-run-2`, 'fleet-state-change', {
        jobId: JOB_ID,
        reason: 'reassignment:test',
      }),
    );
    expect(await prismaBase.notification.count({ where: { jobId: JOB_ID } })).toBe(before);
  });

  it('is silent, not an error, for a walk-in job with no tenant', async () => {
    await processNotification(
      queuedJob(`${PREFIX}-run-walkin`, 'fleet-state-change', {
        jobId: WALKIN_JOB_ID,
        reason: 'reassignment:test',
      }),
    );
    expect(await prismaBase.notification.count({ where: { jobId: WALKIN_JOB_ID } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Fleet Notify Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'FLN',
      name: 'Fleet Notify Zone',
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
      make: 'Fleet Notify Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  // TWO fleet managers on the same tenant — the fact one Notification row per
  // recipient depends on.
  for (const suffix of ['a', 'b']) {
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-fm-${suffix}-user` },
      update: {},
      create: {
        id: `${PREFIX}-fm-${suffix}-user`,
        email: `${PREFIX}-fm-${suffix}@example.test`,
        passwordHash: 'not-used',
        role: 'FLEET_MANAGER',
        name: 'Fixture Fleet Manager',
        memberships: {
          create: { id: `${PREFIX}-fm-${suffix}-mem`, tenantId: TENANT, role: 'FLEET_MANAGER' },
        },
      },
    });
  }

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
      registration: 'KA01FN0001',
      colour: 'White',
    },
  });
  await prismaBase.job.upsert({
    where: { id: JOB_ID },
    update: { status: 'COMMITTED' },
    create: {
      id: JOB_ID,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'COMMITTED',
      safetyLevel: 'NORMAL',
      lat: 12.9352,
      lng: 77.6245,
    },
  });

  // A WALK-IN driver and vehicle — tenantId null throughout, the case the
  // fleet delivery function must skip silently.
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-walkin-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-walkin-driver-user`,
      email: `${PREFIX}-walkin-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Walk-in Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-walkin-driver` },
    update: {},
    create: { id: `${PREFIX}-walkin-driver`, userId: `${PREFIX}-walkin-driver-user`, tenantId: null },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-walkin-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-walkin-vehicle`,
      driverId: `${PREFIX}-walkin-driver`,
      tenantId: null,
      profileId: `${PREFIX}-profile`,
      registration: 'KA01FN0002',
      colour: 'Blue',
    },
  });
  await prismaBase.job.upsert({
    where: { id: WALKIN_JOB_ID },
    update: {},
    create: {
      id: WALKIN_JOB_ID,
      tenantId: null,
      driverId: `${PREFIX}-walkin-driver`,
      vehicleId: `${PREFIX}-walkin-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'COMMITTED',
      safetyLevel: 'NORMAL',
      lat: 12.9352,
      lng: 77.6245,
    },
  });

  // This file owns its own notifications and idempotency rows.
  await prismaBase.notification.deleteMany({ where: { jobId: { in: [JOB_ID, WALKIN_JOB_ID] } } });
  await prismaBase.jobProcessingLog.deleteMany({
    where: { queue: 'notification', idempotencyKey: { startsWith: `${PREFIX}-run-` } },
  });
}
