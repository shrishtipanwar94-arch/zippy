// THE DEMO TIME CONTROL — ageing the board rather than moving the clock.
//
// Every time-dependent behaviour in this system has one shape: read `now`,
// compare it against a stored timestamp. So moving stored timestamps backwards
// is indistinguishable, to every reader, from moving the clock forwards — and
// it costs four columns instead of sixty-eight `new Date()` call sites.
//
// SCOPED, DELIBERATELY. `advanceTime` operates on every live job in the
// database, and `zippy_test` is shared by suites running in parallel. Every
// call below passes the `onlyJobIds` hatch and every assertion names a row this
// file created, so nothing here can age another file's jobs out of their SLA
// windows mid-assertion.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { advanceTime } from '../src/chaos/actions.js';

const PREFIX = 'advtime';

describe('advancing the board', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('ages a live job so a deadline measured from its creation has passed', async () => {
    const before = await job(`${PREFIX}-live`);

    await advanceTime(prismaBase, 40, [`${PREFIX}-live`]);

    const after = await job(`${PREFIX}-live`);
    const movedMinutes = (before.createdAt.getTime() - after.createdAt.getTime()) / 60000;
    expect(Math.round(movedMinutes)).toBe(40);
    // The point of the control: a thirty-minute SLA window measured from
    // createdAt is now closed, without waiting thirty minutes.
    expect(Date.now() - after.createdAt.getTime()).toBeGreaterThan(30 * 60 * 1000);
  });

  it('leaves a finished job alone', async () => {
    // Ageing a RESOLVED job changes nothing anybody can see and would corrupt
    // the settlement history underneath it.
    const before = await job(`${PREFIX}-done`);
    await advanceTime(prismaBase, 40, [`${PREFIX}-done`]);
    const after = await job(`${PREFIX}-done`);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('never rewrites the timeline, because job_events is the truthful record', async () => {
    // The table is append-only at the database level and this control does not
    // try to be the exception. A demo tool that rewrote history would make the
    // one artefact worth showing an interviewer untrustworthy — so the story
    // panel keeps real wall-clock times while the board's behaviour moves, and
    // an ordinary event explains the gap.
    const created = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId: `${PREFIX}-live`, eventType: 'JOB_CREATED' },
      select: { at: true },
    });
    await advanceTime(prismaBase, 15, [`${PREFIX}-live`]);
    const stillThere = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId: `${PREFIX}-live`, eventType: 'JOB_CREATED' },
      select: { at: true },
    });
    expect(stillThere.at.getTime()).toBe(created.at.getTime());

    const explained = await prismaBase.jobEvent.count({
      where: { jobId: `${PREFIX}-live`, eventType: 'DEMO_TIME_ADVANCED' },
    });
    expect(explained).toBeGreaterThan(0);
  });
});

async function job(id: string) {
  return prismaBase.job.findUniqueOrThrow({ where: { id }, select: { createdAt: true } });
}

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'ADV',
      name: 'Advance Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: {
      make_model_yearFrom_yearTo: {
        make: 'ADVTIME',
        model: 'Fixture',
        yearFrom: 2020,
        yearTo: 2025,
      },
    },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'ADVTIME',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-user` },
    update: {},
    create: {
      id: `${PREFIX}-user`,
      email: `${PREFIX}-driver@example.test`,
      passwordHash: 'x',
      role: 'DRIVER',
      name: 'Advance Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-user` },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      profileId: `${PREFIX}-profile`,
      registration: 'ADVTIME0001',
      colour: 'white',
    },
  });

  for (const [id, status] of [
    [`${PREFIX}-live`, 'INTAKE'],
    [`${PREFIX}-done`, 'RESOLVED'],
  ] as const) {
    await prismaBase.job.upsert({
      where: { id },
      update: { status, createdAt: new Date() },
      create: {
        id,
        driverId: `${PREFIX}-driver`,
        vehicleId: `${PREFIX}-vehicle`,
        zoneId: `${PREFIX}-zone`,
        status,
        createdAt: new Date(),
      },
    });
    const existing = await prismaBase.jobEvent.count({
      where: { jobId: id, eventType: 'JOB_CREATED' },
    });
    if (existing === 0) {
      await prismaBase.jobEvent.create({
        data: { jobId: id, sequence: 1, eventType: 'JOB_CREATED', payload: {} },
      });
    }
  }
}
