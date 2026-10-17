// THE DEMO VAN DRIVES TO THE CAR — DEMO_MODE only.
//
// On the real product a technician's phone reports where the van is, and the
// driver's map follows it. On the demo board nobody is in Delhi with a phone,
// so the van's dot sat at its seed position for the whole job, faded, with
// "This is their last known position" under it — the map pinpointed nothing,
// and the distance between the two dots never changed.
//
// So while a demo job is EN_ROUTE, the worker moves its van a step towards the
// car every DRIVE_TICK_MS, at a plain city speed, and stops at the car. The
// step goes through recordUnitPositionQuietly — the SAME path a phone's
// position takes — so the unit row, the last-seen time and the live push to
// both screens are exactly what a real fix produces. Nothing about the job
// changes: the technician still presses "I have arrived".
//
// A straight line, not a road route: production routing is straight-line
// (ROUTING_MODE=HAVERSINE), and the arrival estimate the driver is shown was
// computed the same way, so the dot arriving roughly when the estimate said is
// the honest behaviour.

import type { PrismaClient } from '@prisma/client';
import { distanceKm } from '../domain/geo.js';
import { recordUnitPositionQuietly } from '../commit/unitPosition.js';
import { DEMO_CREWS } from './demoCrews.js';

export const DRIVE_TICK_MS = 10_000;
// About what a van manages across central Delhi; with the 1.4 road factor the
// arrival estimate uses, a 1.9 km straight line takes roughly five minutes.
const SPEED_KMH = 30;

export type PlannedStep = { lat: number; lng: number; arrived: boolean };

// Where the van should be after one tick, given where it is and where the car
// is. Linear in latitude and longitude, which is accurate to a few metres over
// the few kilometres of a demo zone.
export function stepTowards(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  stepKm: number,
): PlannedStep {
  const remainingKm = distanceKm(from.lat, from.lng, to.lat, to.lng);
  if (remainingKm <= stepKm) return { lat: to.lat, lng: to.lng, arrived: true };
  const fraction = stepKm / remainingKm;
  return {
    lat: from.lat + (to.lat - from.lat) * fraction,
    lng: from.lng + (to.lng - from.lng) * fraction,
    arrived: false,
  };
}

// Returns how many vans moved this tick.
export async function advanceDemoDrives(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const stepKm = (SPEED_KMH * DRIVE_TICK_MS) / 3_600_000;
  const jobs = await db.job.findMany({
    where: {
      status: 'EN_ROUTE',
      assignedUnit: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } },
    },
    select: {
      id: true,
      lat: true,
      lng: true,
      assignedTechnicianId: true,
      assignedUnit: { select: { lat: true, lng: true } },
    },
  });

  let moved = 0;
  for (const job of jobs) {
    const van = job.assignedUnit;
    if (job.lat === null || job.lng === null || !job.assignedTechnicianId) continue;
    if (!van || van.lat === null || van.lng === null) continue;
    const alreadyThere = van.lat === job.lat && van.lng === job.lng;
    if (alreadyThere) continue;

    const next = stepTowards({ lat: van.lat, lng: van.lng }, { lat: job.lat, lng: job.lng }, stepKm);
    await recordUnitPositionQuietly(db, {
      jobId: job.id,
      technicianId: job.assignedTechnicianId,
      position: { lat: next.lat, lng: next.lng },
      at: now,
    });
    moved += 1;
  }
  return moved;
}
