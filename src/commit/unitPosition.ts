// WHERE THE VAN IS — the one place a unit's position is written, and the one
// place it is published.
//
// UNTIL NOW NOTHING WROTE THIS AT ALL. `Unit.lat`, `Unit.lng` and
// `Unit.lastLocationAt` have existed since Phase 6 and were populated exactly
// once, by the seed. The only code that read them afterwards was the GPS health
// probe, which is why that probe sat permanently DEGRADED reporting a fleet
// position hours old: it was telling the truth about a feed that did not exist.
//
// So "are positions published to the job room?" had a blunter answer than the
// question assumed — they were not published anywhere, because nothing produced
// them after the seed.
//
// WHERE A POSITION COMES FROM. The technician's phone, on the taps it is
// already making. Every rung of the ladder is a moment that phone is awake, has
// the screen on and knows where it is, so the position rides along with the tap
// rather than needing a background tracker the browser would suspend anyway.
// That makes the feed as coarse as the ladder — a handful of fixes per job, not
// one a second — and this file's whole job is to make sure the driver's screen
// is honest about that rather than drawing a confident dot.
//
// IT IS BEST-EFFORT, DELIBERATELY. A position that fails to record must never
// fail a technician's status tap: the tap is the fact that matters and the dot
// is decoration on top of it. Everything here is wrapped accordingly.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { publishUnitPosition } from '../realtime/publish.js';

// Beyond this the driver's map stops claiming to show where somebody is and
// starts saying when they were last seen. Matched to the health ladder's own
// GPS threshold (src/health/probes.ts) so the fleet-wide degraded state and one
// driver's map cannot disagree about what "stale" means.
export const POSITION_STALE_AFTER_MS = 15 * 60 * 1000;

export type ReportedPosition = { lat: number; lng: number };

// Rejects anything that is not a real coordinate before it reaches the
// database. A phone with no fix reports zeroes, and (0, 0) is in the Atlantic.
export function isPlausiblePosition(position: ReportedPosition): boolean {
  const { lat, lng } = position;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Records a fix against the unit currently crewed by this technician, and tells
// that job's room. Never throws.
export async function recordUnitPositionQuietly(
  db: PrismaClient,
  input: { jobId: string; technicianId: string; position: ReportedPosition; at: Date },
): Promise<void> {
  try {
    if (!isPlausiblePosition(input.position)) return;

    // THE UNIT IS FOUND THROUGH THE JOB, not through the technician's crewing.
    // A technician released from a job mid-shift keeps their van, so crewing
    // alone would let a stale tap move a marker on a job somebody else is now
    // running. The assignment is the thing that makes this position relevant to
    // this driver.
    const job = await db.job.findFirst({
      where: { id: input.jobId, assignedTechnicianId: input.technicianId },
      select: { assignedUnitId: true },
    });
    if (!job?.assignedUnitId) return;

    // Last write wins, and there is no version guard. Two fixes racing is not a
    // conflict worth resolving — the loser is a position a second older, and
    // the driver's map is better off with either of them than with neither.
    await db.unit.update({
      where: { id: job.assignedUnitId },
      data: { lat: input.position.lat, lng: input.position.lng, lastLocationAt: input.at },
    });

    await publishUnitPosition({
      jobId: input.jobId,
      unitId: job.assignedUnitId,
      lat: input.position.lat,
      lng: input.position.lng,
      at: input.at.toISOString(),
    });
  } catch (error) {
    // A dot on a map is not worth failing a status tap for.
    logger.warn({ err: error, jobId: input.jobId }, 'could not record a unit position');
  }
}

// HOW OLD IS THIS FIX, in the words a driver reads.
//
// A map that lies is worse than no map. The rule this expresses is that the
// screen never presents an old position as a current one: under a couple of
// minutes it says nothing (the dot is as good as live), past that it says how
// long ago, and past the stale threshold it stops describing a position at all
// and describes a last known one.
export function describePositionAge(
  lastSeenAt: Date | null,
  now: Date,
): { text: string | null; stale: boolean } {
  if (!lastSeenAt) return { text: 'We do not have their position yet.', stale: true };

  const ageMs = now.getTime() - lastSeenAt.getTime();
  const minutes = Math.round(ageMs / 60_000);

  if (ageMs >= POSITION_STALE_AFTER_MS) {
    return { text: 'This is their last known position, not where they are now.', stale: true };
  }
  if (minutes < 2) return { text: null, stale: false };
  return { text: `Last seen ${minutes} minutes ago`, stale: false };
}
