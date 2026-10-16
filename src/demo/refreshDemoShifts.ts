// KEEP THE DEMO CREWS ON SHIFT: started an hour ago, ending in eight.
//
// A shift is a pair of timestamps, so any fixed shift goes stale. Once every
// demo technician's shift has ended, every option fails NO_TECHNICIAN_ON_SHIFT
// and a cold visitor finds a board on which nothing can be dispatched. The
// worker calls this on boot and every fifteen minutes when DEMO_MODE=true, so
// the window always surrounds "now". ensureDemoBoard calls it too, so a fresh
// board is on shift from the moment it exists.
//
// A van on a live job is skipped (invariant 7, see busyDemoUnits.ts), and only
// demo technicians are ever selected (idleDemoCrews.ts).

import type { PrismaClient } from '@prisma/client';
import { DEMO_ZONE } from './demoCrews.js';
import { findIdleDemoCrews } from './idleDemoCrews.js';

const SHIFT_STARTED_HOURS_AGO = 1;
const SHIFT_ENDS_IN_HOURS = 8;

// Returns the technician ids whose shift was replaced.
export async function refreshDemoShifts(db: PrismaClient, now: Date = new Date()): Promise<string[]> {
  const idle = await findIdleDemoCrews(db);
  const startsAt = new Date(now.getTime() - SHIFT_STARTED_HOURS_AGO * 60 * 60_000);
  const endsAt = new Date(now.getTime() + SHIFT_ENDS_IN_HOURS * 60 * 60_000);

  const refreshed: string[] = [];
  for (const { technicianId } of idle) {
    // Replaced, not added to: two overlapping shifts for one technician is a
    // state the main seed avoids, and the duty toggle reads the latest one.
    // In one transaction so a reader never sees the technician with no shift.
    await db.$transaction([
      db.technicianShift.deleteMany({ where: { technicianId } }),
      db.technicianShift.create({ data: { technicianId, zoneId: DEMO_ZONE.id, startsAt, endsAt } }),
    ]);
    refreshed.push(technicianId);
  }
  return refreshed;
}
