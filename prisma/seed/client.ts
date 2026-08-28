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
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

export const START_OF_YEAR = new Date('2026-01-01T00:00:00.000Z');
