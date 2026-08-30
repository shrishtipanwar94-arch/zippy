// Thirty-one technicians with a deliberately UNEVEN capability matrix. Scarcity
// is the point: later scenarios put three simultaneous EV calls against two
// certified technicians and watch what the dispatcher does. The exact counts
// the build plan pins:
//   EV_HV_CERTIFICATION  exactly 2
//   KEY_PROGRAMMING      exactly 3
//   OBD_DIAGNOSTICS      exactly 18
//   the three BASIC codes  all 31
// Everything else is spread unevenly but is not load-bearing for a scenario.

import type { PrismaClient } from '@prisma/client';
import { dayAt } from './client.js';
import { capabilityId } from './capabilities.js';
import { DEV_PASSWORD_HASH } from './devPassword.js';
import { zoneId } from './zones.js';

export const TECHNICIAN_COUNT = 31;

// A technician serves every fleet, but a login still needs one tenant to scope
// to — resolveTenantBinding (src/api/auth.ts) takes the first membership, and
// with no membership the login carries tenantId null and every tenant-scoped
// query returns nothing. Round-robin the seeded workforce across the three
// fleet tenants so each technician login lands in a real one.
const FLEET_TENANT_IDS = ['tenant-metrocab', 'tenant-citylogistics', 'tenant-quickmove'];

// Given a zero-based technician index, the capability codes that technician
// holds. Ranges are half-open: `i < 18` is exactly indices 0..17.
export function technicianCapabilities(i: number): string[] {
  const codes: string[] = ['JUMP_START', 'TYRE_CHANGE', 'FUEL_DELIVERY'];
  if (i < 20) codes.push('LOCKOUT');
  if (i < 18) codes.push('OBD_DIAGNOSTICS'); // exactly 18
  if (i < 14) codes.push('BATTERY_REPLACEMENT');
  if (i >= 4 && i < 12) codes.push('BRAKE_REPAIR');
  if (i >= 5 && i < 11) codes.push('ALTERNATOR_REPLACEMENT');
  if (i < 3) codes.push('KEY_PROGRAMMING'); // exactly 3
  if (i < 2) codes.push('EV_HV_CERTIFICATION'); // exactly 2
  if (i >= 18 && i < 26) codes.push('WINCH_RECOVERY');
  if (i >= 18 && i < 24) codes.push('FLATBED_LOADING');
  return codes;
}

export type ShiftBand = 'NIGHT' | 'MORNING' | 'DAY' | 'EVENING';

// Which band a technician works. Exposed so crewing can spread the fleet's
// crews across the day instead of clustering them all on mornings.
export function shiftBand(i: number): ShiftBand {
  if (i % 7 === 6) return 'NIGHT';
  const band = i % 3;
  if (band === 0) return 'MORNING';
  if (band === 1) return 'DAY';
  return 'EVENING';
}

// Bands that overlap only at their edges: 10:00-14:00 is covered by morning +
// day, 14:00-18:00 by day + evening. A few technicians run nights, where 30
// means 06:00 the following day.
//
// The band a technician works and the hours that band means are ONE fact with
// one home: `shiftBand` decides the band, this table turns a band into hours,
// and `shiftFor` is the composition. Writing the hours out a second time in a
// parallel if-chain is exactly the shape that produced the onHighway bug.
const SHIFT_HOURS: Record<ShiftBand, { from: number; to: number }> = {
  NIGHT: { from: 22, to: 30 },
  MORNING: { from: 6, to: 14 },
  DAY: { from: 10, to: 18 },
  EVENING: { from: 14, to: 22 },
};

// TWO CONSECUTIVE DAYS PER TECHNICIAN, and the gap that forced it.
//
// The bands above cover 06:00 through to 06:00 the following morning: morning,
// day and evening tile 06:00-22:00, and the night band runs 22:00 to 06:00.
// Nothing in that set starts before 06:00, so the 00:00-06:00 window of any
// given day is covered ONLY by the previous day's night shift.
//
// While each technician had exactly one shift row, keyed `shift-<id>`, a
// re-seed OVERWROTE that previous night with tonight's — so seeding at 03:00
// deleted the only shift covering 03:00 and left the whole fleet off duty. It
// is a self-inflicted outage that appears for six hours a day and vanishes for
// the other eighteen, which is exactly the kind of thing that looks like a
// solver bug: every option comes back NO_TECHNICIAN_ON_SHIFT while the
// capabilities all match.
//
// Writing yesterday AND today per technician closes the seam. The union runs
// from 06:00 yesterday to 06:00 tomorrow — a continuous window containing
// every hour of today no matter what time the seed runs. Two rows per
// technician is fine downstream: feasibility asks whether ANY of a
// technician's shifts covers the job (`shifts.some(...)` in
// hasShiftTimeToComplete), not whether their one shift does.
const SHIFT_DAY_OFFSETS = [-1, 0] as const;

function shiftFor(i: number, dayOffset: number): { startsAt: Date; endsAt: Date } {
  const hours = SHIFT_HOURS[shiftBand(i)];
  return { startsAt: dayAt(dayOffset, hours.from), endsAt: dayAt(dayOffset, hours.to) };
}

// The row id for one technician's shift on one day. The zero-offset id is left
// exactly as it was so an existing database updates its row in place rather
// than accumulating an orphan next to a renamed one.
function shiftId(technicianId: string, dayOffset: number): string {
  return dayOffset === 0 ? `shift-${technicianId}` : `shift-${technicianId}-d${dayOffset}`;
}

export async function seedTechnicians(prisma: PrismaClient): Promise<void> {
  for (let i = 0; i < TECHNICIAN_COUNT; i++) {
    const number = String(i + 1).padStart(2, '0');
    const userId = `user-tech-${number}`;
    const technicianId = `tech-${number}`;
    const email = `tech${number}@zippy.internal`;
    const home = zoneId(i);

    await prisma.user.upsert({
      where: { email },
      update: { name: `Technician ${number}`, passwordHash: DEV_PASSWORD_HASH },
      create: {
        id: userId,
        email,
        passwordHash: DEV_PASSWORD_HASH,
        role: 'TECHNICIAN',
        name: `Technician ${number}`,
      },
    });

    await prisma.technician.upsert({
      where: { id: technicianId },
      update: { homeZoneId: home, active: true },
      create: {
        id: technicianId,
        userId,
        employeeCode: `EMP-${number}`,
        homeZoneId: home,
        active: true,
      },
    });

    const membershipTenantId = FLEET_TENANT_IDS[i % FLEET_TENANT_IDS.length];
    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: membershipTenantId, userId } },
      update: { role: 'TECHNICIAN' },
      create: { id: `membership-${technicianId}`, tenantId: membershipTenantId, userId, role: 'TECHNICIAN' },
    });

    for (const code of technicianCapabilities(i)) {
      const capId = capabilityId(code);
      await prisma.technicianCapability.upsert({
        where: { technicianId_capabilityId: { technicianId, capabilityId: capId } },
        update: {},
        create: { id: `techcap-${number}-${code.toLowerCase()}`, technicianId, capabilityId: capId },
      });
    }

    for (const dayOffset of SHIFT_DAY_OFFSETS) {
      const shift = shiftFor(i, dayOffset);
      const id = shiftId(technicianId, dayOffset);
      await prisma.technicianShift.upsert({
        where: { id },
        update: { startsAt: shift.startsAt, endsAt: shift.endsAt, zoneId: home },
        create: {
          id,
          technicianId,
          zoneId: home,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
        },
      });
    }
  }
}

// The seeded workforce as plain data, so `crews.ts` can reason about who can
// crew what without duplicating any of the rules above.
export type TechnicianPlan = {
  technicianId: string;
  index: number;
  capabilities: string[];
  homeZoneId: string;
  band: ShiftBand;
};

// The shift windows the seed would write, as plain data. Exposed so the
// 24-hour coverage property can be tested without a database — see
// tests/shifts.test.ts for why that matters more than seeding and looking.
export type ShiftWindow = { technicianId: string; startsAt: Date; endsAt: Date };

export function shiftPlan(): ShiftWindow[] {
  const windows: ShiftWindow[] = [];
  for (let i = 0; i < TECHNICIAN_COUNT; i++) {
    const technicianId = `tech-${String(i + 1).padStart(2, '0')}`;
    for (const dayOffset of SHIFT_DAY_OFFSETS) {
      windows.push({ technicianId, ...shiftFor(i, dayOffset) });
    }
  }
  return windows;
}

export function technicianPlan(): TechnicianPlan[] {
  const plan: TechnicianPlan[] = [];
  for (let i = 0; i < TECHNICIAN_COUNT; i++) {
    plan.push({
      technicianId: `tech-${String(i + 1).padStart(2, '0')}`,
      index: i,
      capabilities: technicianCapabilities(i),
      homeZoneId: zoneId(i),
      band: shiftBand(i),
    });
  }
  return plan;
}
