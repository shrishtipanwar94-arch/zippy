// THE DEMO BOARD ENSURES ITSELF, AND LEAVES A BUSY VAN ALONE.
//
// Two claims the deployed demo rests on (DEMO_MODE=true):
//   1. ensureDemoBoard runs on EVERY web boot, so running it twice must leave
//      exactly the rows running it once did — no second zone, no doubled
//      capability links, no extra shifts.
//   2. refreshDemoShifts runs every fifteen minutes from the worker, and must
//      never touch a van with a live job (invariant 7).
//
// ON ITS OWN DATABASE (tests/helpers/demoDatabase.ts), not the shared
// `zippy_test`: crew B can do everything, so on the shared board it won other
// suites' jobs while this file ran. Nothing else reads `zippy_test_demo`, so
// these assertions can name B and A directly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openDemoDatabase } from './helpers/demoDatabase.js';
import { ensureDemoBoard } from '../prisma/seed/demoBoard.js';
import { refreshDemoShifts } from '../src/demo/refreshDemoShifts.js';
import { freeStuckDemoVans } from '../src/demo/freeDemoVans.js';
import {
  DEMO_CREWS,
  DEMO_DISPATCHER,
  DEMO_DRIVER,
  DEMO_REFERENCE_DRIVER,
  DEMO_TECHNICIAN_IDS,
  DEMO_UNIT_IDS,
  DEMO_ZONE,
} from '../src/demo/demoCrews.js';

const RUN = Date.now();
const BUSY_JOB_ID = `demoboard-test-job-${RUN}`;
const RUNNING_JOB_ID = `demoboard-test-running-${RUN}`;

let db: PrismaClient;

async function countDemoRows(): Promise<Record<string, number>> {
  const emails = [DEMO_DISPATCHER.email, DEMO_DRIVER.email, ...DEMO_CREWS.map((crew) => crew.email)];
  return {
    users: await db.user.count({ where: { email: { in: emails } } }),
    zones: await db.zone.count({ where: { code: DEMO_ZONE.code } }),
    vehicles: await db.vehicle.count({ where: { registration: DEMO_DRIVER.registration } }),
    memberships: await db.tenantMembership.count({ where: { userId: DEMO_DRIVER.userId } }),
    technicians: await db.technician.count({
      where: { employeeCode: { in: DEMO_CREWS.map((crew) => crew.employeeCode) } },
    }),
    units: await db.unit.count({ where: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } } }),
    technicianCapabilities: await db.technicianCapability.count({
      where: { technicianId: { in: DEMO_TECHNICIAN_IDS } },
    }),
    unitCapabilities: await db.unitCapability.count({ where: { unitId: { in: DEMO_UNIT_IDS } } }),
    shifts: await db.technicianShift.count({ where: { technicianId: { in: DEMO_TECHNICIAN_IDS } } }),
    stockLines: await db.unitStock.count({ where: { unitId: { in: DEMO_UNIT_IDS } } }),
    workshops: await db.workshop.count({ where: { code: 'WS-DMO' } }),
    referenceJobs: await db.job.count({
      where: { vehicle: { registration: DEMO_REFERENCE_DRIVER.registration } },
    }),
  };
}

async function shiftOf(technicianId: string): Promise<{ startsAt: Date; endsAt: Date }> {
  return db.technicianShift.findFirstOrThrow({
    where: { technicianId },
    select: { startsAt: true, endsAt: true },
  });
}

beforeAll(async () => {
  db = await openDemoDatabase();
  await ensureDemoBoard(db);
}, 60_000);

afterAll(async () => {
  await db.job.deleteMany({ where: { id: { in: [BUSY_JOB_ID, RUNNING_JOB_ID] } } });
  await db.$disconnect();
});

describe('ensureDemoBoard', () => {
  it('leaves the same rows when run twice', async () => {
    const afterFirst = await countDemoRows();
    await ensureDemoBoard(db);
    const afterSecond = await countDemoRows();

    expect(afterSecond).toEqual(afterFirst);
    // And the counts are the board it claims to build, not merely stable.
    expect(afterFirst.zones).toBe(1);
    // The reference job is created once, through the real dispatch path, and
    // never again however many times the board is ensured.
    expect(afterFirst.referenceJobs).toBe(1);
    expect(afterFirst.workshops).toBe(1);
    expect(afterFirst.users).toBe(2 + DEMO_CREWS.length);
    expect(afterFirst.technicians).toBe(DEMO_CREWS.length);
    expect(afterFirst.units).toBe(DEMO_CREWS.length);
    expect(afterFirst.shifts).toBe(DEMO_CREWS.length);
    let grantedLinks = 0;
    let stockedLines = 0;
    for (const crew of DEMO_CREWS) {
      grantedLinks += crew.capabilities.length;
      stockedLines += crew.stockedSkus.length;
    }
    expect(afterFirst.technicianCapabilities).toBe(grantedLinks);
    expect(afterFirst.unitCapabilities).toBe(grantedLinks);
    expect(afterFirst.stockLines).toBe(stockedLines);
  });
});

describe('refreshDemoShifts', () => {
  it('skips a van with a live job and refreshes every other demo crew', async () => {
    const busyCrew = DEMO_CREWS.find((crew) => crew.label === 'B')!;
    const idleCrew = DEMO_CREWS.find((crew) => crew.label === 'A')!;

    // A COMMITTED job on crew B's van, written directly: this test is about
    // the refresh's guard, not about how a job gets committed.
    await db.job.create({
      data: {
        id: BUSY_JOB_ID,
        driverId: DEMO_DRIVER.driverId,
        vehicleId: DEMO_DRIVER.vehicleId,
        zoneId: DEMO_ZONE.id,
        status: 'COMMITTED',
        assignedUnitId: busyCrew.unitId,
        createdAt: new Date('2020-06-01T10:00:00.000Z'),
      },
    });

    const busyBefore = await shiftOf(busyCrew.technicianId);
    const idleBefore = await shiftOf(idleCrew.technicianId);

    // An hour on, so a refreshed shift is visibly different from the old one.
    const later = new Date(Date.now() + 60 * 60_000);
    const refreshed = await refreshDemoShifts(db, later);

    expect(refreshed).not.toContain(busyCrew.technicianId);
    expect(refreshed).toContain(idleCrew.technicianId);
    for (const technicianId of refreshed) {
      expect(DEMO_TECHNICIAN_IDS).toContain(technicianId);
    }

    expect(await shiftOf(busyCrew.technicianId)).toEqual(busyBefore);
    const idleAfter = await shiftOf(idleCrew.technicianId);
    expect(idleAfter.startsAt.getTime()).toBeGreaterThan(idleBefore.startsAt.getTime());
  });
});

describe('freeStuckDemoVans', () => {
  it('frees a van left stuck with no job, and never touches one on a running job', async () => {
    const stuck = DEMO_CREWS.find((crew) => crew.label === 'C')!;
    const working = DEMO_CREWS.find((crew) => crew.label === 'D')!;

    // C: marked ON_JOB, but nothing is assigned to it — the leftover a
    // flushed queue or an ill-timed restart can leave behind.
    await db.unit.update({ where: { id: stuck.unitId }, data: { status: 'ON_JOB' } });
    // D: genuinely on a job, en route.
    await db.unit.update({ where: { id: working.unitId }, data: { status: 'ON_JOB' } });
    await db.job.create({
      data: {
        id: RUNNING_JOB_ID,
        driverId: DEMO_DRIVER.driverId,
        vehicleId: DEMO_DRIVER.vehicleId,
        zoneId: DEMO_ZONE.id,
        status: 'EN_ROUTE',
        assignedUnitId: working.unitId,
        createdAt: new Date('2020-06-01T11:00:00.000Z'),
      },
    });

    const freed = await freeStuckDemoVans(db);

    expect(freed.vansFreed).toContain(stuck.unitCode);
    expect(freed.vansFreed).not.toContain(working.unitCode);
    const units = await db.unit.findMany({
      where: { id: { in: [stuck.unitId, working.unitId] } },
      select: { id: true, status: true },
    });
    const statusOf = (id: string) => units.find((unit) => unit.id === id)?.status;
    expect(statusOf(stuck.unitId)).toBe('AVAILABLE');
    expect(statusOf(working.unitId)).toBe('ON_JOB');

    // Put D back for the next run of this file; the job is removed in afterAll.
    await db.job.update({ where: { id: RUNNING_JOB_ID }, data: { status: 'CANCELLED' } });
    await db.unit.update({ where: { id: working.unitId }, data: { status: 'AVAILABLE' } });
  });
});
