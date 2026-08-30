// One Prisma client for the whole seed run. The seed is the only place that
// writes rows outside a migration, so it gets its own client rather than
// importing the app's (which pulls in config validation the seed does not need).

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Every seeder anchors time-of-day data (shifts, contract start dates) to
// midnight *today* so a re-run on the same day is a genuine no-op. Re-running
// on a later day simply moves the shifts forward — still idempotent, never a
// duplicate.
export function todayAt(hour: number, minute = 0): Date {
  return dayAt(0, hour, minute);
}

// The same anchor, offset by whole days: `dayAt(-1, 22)` is 22:00 yesterday.
// `setDate` is what does the offsetting rather than subtracting 24 hours in
// milliseconds, because a day is not always 86,400 seconds long — across a
// daylight-saving boundary it is 23 or 25 hours, and the arithmetic version
// silently lands an hour off. India has no DST, so this is correctness for a
// deployment elsewhere rather than a bug fixed here, but the right version
// costs nothing.
//
// An hour is passed through to `setHours` unclamped on purpose: `dayAt(0, 30)`
// means 06:00 tomorrow, which is how a night shift crossing midnight is
// written as one band.
export function dayAt(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export const START_OF_YEAR = new Date('2026-01-01T00:00:00.000Z');
