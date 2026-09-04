// ON DUTY OR OFF — the technician's own switch, on the thing the solver
// already reads.
//
// WHY A SHIFT AND NOT A FLAG. Availability is already modelled: the feasibility
// engine rejects a crew with `NO_TECHNICIAN_ON_SHIFT` when there is no
// TechnicianShift covering now, and that is by far the most common rejection on
// a real board. Adding an `isAvailable` boolean beside it would be a second
// answer to one question — the exact shape of bug this codebase keeps finding —
// and the two would disagree the first time anybody forgot one of them.
//
// So going off duty ENDS THE CURRENT SHIFT and coming back on STARTS ONE. The
// solver needs no changes at all, because nothing about what it reads has
// changed.
//
// ENDING IS NOT DELETING. A technician who stops at 3pm worked until 3pm, and
// the roster is a record of what was worked — so the row is truncated rather
// than removed, the same thing src/chaos/actions.ts does when it takes somebody
// offline.
//
// A JOB IN HAND IS NOT ABANDONED. Going off duty stops NEW offers; it does not
// release work already accepted. Dropping a job somebody is standing next to
// would be a dispatch decision, and this is a preference — the release path is
// the dispatcher's, through the action queue.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';

// How long a shift started from the phone runs for. A technician who taps "on
// duty" is saying "I am working now", not committing to a fixed window, and the
// honest end of an unspecified working day is the end of the day.
const SHIFT_RUNS_UNTIL_END_OF_DAY_MS = 12 * 60 * 60 * 1000;

export type DutyState = { onDuty: boolean; until: string | null };

export async function readDuty(
  db: PrismaClient,
  technicianId: string,
  now: Date,
): Promise<DutyState> {
  const shift = await db.technicianShift.findFirst({
    where: { technicianId, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
    select: { endsAt: true },
  });
  return { onDuty: Boolean(shift), until: shift?.endsAt.toISOString() ?? null };
}

export async function setDuty(
  db: PrismaClient,
  input: { technicianId: string; onDuty: boolean; now: Date },
): Promise<DutyState> {
  const { technicianId, onDuty, now } = input;

  if (!onDuty) {
    // Every shift still running is truncated to now. `updateMany` rather than a
    // read-then-write: two taps racing should both land on "ended now", and
    // there is nothing to compare-and-swap against.
    await db.technicianShift.updateMany({
      where: { technicianId, endsAt: { gt: now } },
      data: { endsAt: now },
    });
    logger.info({ technicianId }, 'technician went off duty');
    return { onDuty: false, until: null };
  }

  // Already on duty is a no-op rather than a second overlapping shift. Two rows
  // covering the same hour would make the roster read as double time worked.
  const existing = await readDuty(db, technicianId, now);
  if (existing.onDuty) return existing;

  const technician = await db.technician.findUnique({
    where: { id: technicianId },
    select: { homeZoneId: true, currentUnit: { select: { zoneId: true } } },
  });

  const endsAt = new Date(now.getTime() + SHIFT_RUNS_UNTIL_END_OF_DAY_MS);
  await db.technicianShift.create({
    data: {
      technicianId,
      // The van's zone if they are crewed, their home zone otherwise. Null is
      // allowed by the schema and means "no zone", which would quietly exclude
      // them from zone-partitioned solves.
      zoneId: technician?.currentUnit?.zoneId ?? technician?.homeZoneId ?? null,
      startsAt: now,
      endsAt,
    },
  });

  logger.info({ technicianId }, 'technician came on duty');
  return { onDuty: true, until: endsAt.toISOString() };
}
