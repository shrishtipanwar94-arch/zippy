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
import { todayAt } from './client.js';
import { capabilityId } from './capabilities.js';
import { zoneId } from './zones.js';

const PLACEHOLDER_HASH = 'seed-placeholder-not-a-real-hash';
export const TECHNICIAN_COUNT = 31;

// Given a zero-based technician index, the capability codes that technician
// holds. Ranges are half-open: `i < 18` is exactly indices 0..17.
function capabilitiesFor(i: number): string[] {
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

// Three shift bands that overlap only in their edges: 10:00-14:00 is covered by
// morning + day, 14:00-18:00 by day + evening. A few technicians run nights.
function shiftFor(i: number): { startsAt: Date; endsAt: Date } {
  if (i % 7 === 6) return { startsAt: todayAt(22), endsAt: todayAt(30) }; // 22:00 -> 06:00 next day
  const band = i % 3;
  if (band === 0) return { startsAt: todayAt(6), endsAt: todayAt(14) };
  if (band === 1) return { startsAt: todayAt(10), endsAt: todayAt(18) };
  return { startsAt: todayAt(14), endsAt: todayAt(22) };
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
      update: { name: `Technician ${number}` },
      create: {
        id: userId,
        email,
        passwordHash: PLACEHOLDER_HASH,
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

    for (const code of capabilitiesFor(i)) {
      const capId = capabilityId(code);
      await prisma.technicianCapability.upsert({
        where: { technicianId_capabilityId: { technicianId, capabilityId: capId } },
        update: {},
        create: { id: `techcap-${number}-${code.toLowerCase()}`, technicianId, capabilityId: capId },
      });
    }

    const shift = shiftFor(i);
    await prisma.technicianShift.upsert({
      where: { id: `shift-${technicianId}` },
      update: { startsAt: shift.startsAt, endsAt: shift.endsAt, zoneId: home },
      create: {
        id: `shift-${technicianId}`,
        technicianId,
        zoneId: home,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
      },
    });
  }
}
