// THE DEMO BOARD ENSURES ITSELF, AND LEAVES A BUSY VAN ALONE.
//
// Two claims the deployed demo rests on (DEMO_MODE=true):
//   1. ensureDemoBoard runs on EVERY web boot, so running it twice must leave
//      exactly the rows running it once did — no second zone, no doubled
//      capability links, no extra shifts.
//   2. refreshDemoShifts runs every fifteen minutes from the worker, and must
//      never touch a van with a live job (invariant 7).
//
// SCOPED, NOT RAW, COUNTS. `zippy_test` is shared by every suite and vitest
// runs files in parallel, so every count below is of rows identified by the
// demo board's own natural keys (CLAUDE.md, GOTCHAS).
//
// THE DEMO CREWS COMPETE WITH OTHER SUITES' FIXTURES while this file runs —
// buildDispatchSnapshot reads the whole fleet. They hold no BRAKE_REPAIR and no
// EV_HV_CERTIFICATION, so they cannot serve the two scarce-pair fixtures
// (tests/redispatch*.test.ts), and afterAll takes the IDLE ones off the board
// again so the window is this file's runtime, not forever.
//
// THEY CAN STILL WIN ANOTHER SUITE'S JOB, legitimately: tests/demoFlow.test.ts
// runs a real dispatch near Connaught Place, and once chose crew B and held its
// van. This file's first afterAll then forced every demo van OFFLINE, including
// that HELD one, and demoFlow's accept failed — this file breaking the exact
// rule it exists to pin. So afterAll now leaves busy vans alone, and the test
// picks its crews from whichever are idle rather than assuming B and A.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { ensureDemoBoard } from '../prisma/seed/demoBoard.js';
import { refreshDemoShifts } from '../src/demo/refreshDemoShifts.js';
import { findIdleDemoCrews } from '../src/demo/idleDemoCrews.js';
import {
  DEMO_CREWS,
  DEMO_DISPATCHER,
  DEMO_DRIVER,
  DEMO_TECHNICIAN_IDS,
  DEMO_UNIT_IDS,
  DEMO_ZONE,
} from '../src/demo/demoCrews.js';

const RUN = Date.now();
const BUSY_JOB_ID = `demoboard-test-job-${RUN}`;

async function countDemoRows(): Promise<Record<string, number>> {
  const emails = [DEMO_DISPATCHER.email, DEMO_DRIVER.email, ...DEMO_CREWS.map((crew) => crew.email)];
  return {
    users: await prismaBase.user.count({ where: { email: { in: emails } } }),
    zones: await prismaBase.zone.count({ where: { code: DEMO_ZONE.code } }),
    vehicles: await prismaBase.vehicle.count({ where: { registration: DEMO_DRIVER.registration } }),
    memberships: await prismaBase.tenantMembership.count({ where: { userId: DEMO_DRIVER.userId } }),
    technicians: await prismaBase.technician.count({
      where: { employeeCode: { in: DEMO_CREWS.map((crew) => crew.employeeCode) } },
    }),
    units: await prismaBase.unit.count({ where: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } } }),
    technicianCapabilities: await prismaBase.technicianCapability.count({
      where: { technicianId: { in: DEMO_TECHNICIAN_IDS } },
    }),
    unitCapabilities: await prismaBase.unitCapability.count({ where: { unitId: { in: DEMO_UNIT_IDS } } }),
    shifts: await prismaBase.technicianShift.count({ where: { technicianId: { in: DEMO_TECHNICIAN_IDS } } }),
    stockLines: await prismaBase.unitStock.count({ where: { unitId: { in: DEMO_UNIT_IDS } } }),
  };
}

async function shiftOf(technicianId: string): Promise<{ startsAt: Date; endsAt: Date }> {
  return prismaBase.technicianShift.findFirstOrThrow({
    where: { technicianId },
    select: { startsAt: true, endsAt: true },
  });
}

beforeAll(async () => {
  await ensureDemoBoard(prismaBase);
});

afterAll(async () => {
  await prismaBase.job.deleteMany({ where: { id: BUSY_JOB_ID } });
  // Off the board between runs — no shift, and OFFLINE — but only the idle
  // crews: a van another suite is mid-way through reserving stays as it is.
  // The next run of this file brings them back through ensureDemoBoard.
  const idle = await findIdleDemoCrews(prismaBase);
  const idleTechnicianIds = idle.map((entry) => entry.technicianId);
  const idleUnitIds = idle.map((entry) => entry.unitId);
  await prismaBase.technicianShift.deleteMany({ where: { technicianId: { in: idleTechnicianIds } } });
  await prismaBase.unit.updateMany({ where: { id: { in: idleUnitIds } }, data: { status: 'OFFLINE' } });
});

describe('ensureDemoBoard', () => {
  it('leaves the same rows when run twice', async () => {
    const afterFirst = await countDemoRows();
    await ensureDemoBoard(prismaBase);
    const afterSecond = await countDemoRows();

    expect(afterSecond).toEqual(afterFirst);
    // And the counts are the board it claims to build, not merely stable.
    expect(afterFirst.zones).toBe(1);
    expect(afterFirst.users).toBe(2 + DEMO_CREWS.length);
    expect(afterFirst.technicians).toBe(DEMO_CREWS.length);
    expect(afterFirst.units).toBe(DEMO_CREWS.length);
    expect(afterFirst.shifts).toBe(DEMO_CREWS.length);
    let grantedLinks = 0;
    for (const crew of DEMO_CREWS) grantedLinks += crew.capabilities.length;
    expect(afterFirst.technicianCapabilities).toBe(grantedLinks);
    expect(afterFirst.unitCapabilities).toBe(grantedLinks);
  });
});

describe('refreshDemoShifts', () => {
  it('skips a van with a live job and refreshes every other demo crew', async () => {
    // Two crews nobody else is using right now — see the header for why this
    // cannot simply be B and A.
    const idle = await findIdleDemoCrews(prismaBase);
    expect(idle.length).toBeGreaterThanOrEqual(2);
    const busyCrew = idle[0]!.crew;
    const idleCrew = idle[1]!.crew;

    // A COMMITTED job on crew B's van, written directly. Dated in the past so
    // it never occupies a "newest fifty" slot another suite is asserting on.
    await prismaBase.job.create({
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
    const refreshed = await refreshDemoShifts(prismaBase, later);

    expect(refreshed).not.toContain(busyCrew.technicianId);
    expect(refreshed).toContain(idleCrew.technicianId);
    // Only demo technicians are ever touched.
    for (const technicianId of refreshed) {
      expect(DEMO_TECHNICIAN_IDS).toContain(technicianId);
    }

    expect(await shiftOf(busyCrew.technicianId)).toEqual(busyBefore);
    const idleAfter = await shiftOf(idleCrew.technicianId);
    expect(idleAfter.startsAt.getTime()).toBeGreaterThan(idleBefore.startsAt.getTime());
  });
});
