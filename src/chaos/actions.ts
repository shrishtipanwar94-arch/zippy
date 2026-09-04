// THE FOUR CONTROLS THAT ARE EVENTS, NOT MODES.
//
// A switch stays on until somebody turns it off. These do not: taking a
// technician offline, breaking a unit mid-job, making a destination decline
// and injecting jobs all HAPPEN, once, to real rows, and the system's response
// is the thing being demonstrated. Modelling them as switches would mean a
// demo could leave one on and never find out why the fleet kept shrinking.
//
// THEY GO THROUGH THE SAME WRITES AS THE REAL THING. Taking a technician
// offline uses the ordinary shift write and fires the ordinary replan trigger;
// injecting a job goes through real intake. A control that took a shortcut
// would demonstrate the shortcut. That is also why this file is thin: almost
// every line delegates.
//
// DEV AND DEMO ONLY — the route that reaches this refuses to exist in a
// production build (src/api/chaos.ts).

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { createIntakeJob } from '../intake/createJob.js';
import { enqueueSolve } from '../workers/solver.js';
import { appendJobEvent } from '../intake/events.js';

export const CHAOS_ACTIONS = [
  'TECHNICIAN_OFFLINE',
  'BREAK_UNIT',
  'DECLINE_DESTINATION',
  'INJECT_JOBS',
] as const;

export type ChaosActionName = (typeof CHAOS_ACTIONS)[number];

export function isChaosActionName(value: string): value is ChaosActionName {
  return (CHAOS_ACTIONS as readonly string[]).includes(value);
}

export type ChaosActionResult = { action: ChaosActionName; detail: string };

// A technician walks away mid-shift. The unit they were on is left AVAILABLE
// with nobody in it, which is exactly the state the feasibility filter's
// NO_TECHNICIAN_ON_SHIFT code exists for — so this is also the fastest way to
// produce an escalation card with a real reason on it.
export async function takeTechnicianOffline(
  db: PrismaClient,
  technicianId: string | null,
): Promise<ChaosActionResult> {
  const technician = technicianId
    ? await db.technician.findUnique({ where: { id: technicianId }, select: { id: true, currentUnit: { select: { id: true, zoneId: true } } } })
    : await db.technician.findFirst({
        where: { currentUnit: { isNot: null } },
        select: { id: true, currentUnit: { select: { id: true, zoneId: true } } },
      });

  if (!technician) return { action: 'TECHNICIAN_OFFLINE', detail: 'no technician to take offline' };

  // Ending the shift, not deleting it: the roster is a record of what was
  // worked, and a technician who walked off at 3pm worked until 3pm.
  await db.technicianShift.updateMany({
    where: { technicianId: technician.id, endsAt: { gt: new Date() } },
    data: { endsAt: new Date() },
  });

  const zoneId = technician.currentUnit?.zoneId;
  if (zoneId) await enqueueSolve(zoneId, 'CHAOS_TECHNICIAN_OFFLINE');

  logger.warn({ technicianId: technician.id }, 'chaos: technician taken offline');
  return { action: 'TECHNICIAN_OFFLINE', detail: `technician ${technician.id} is off shift` };
}

// A van breaks down on its way to a breakdown. The unit goes to MAINTENANCE —
// the schema's word for "this vehicle is not going anywhere" — and the zone is
// re-planned through the ordinary trigger, which is the re-dispatch path
// Phase 12 built rather than a special case.
export async function breakUnit(
  db: PrismaClient,
  unitId: string | null,
): Promise<ChaosActionResult> {
  const unit = unitId
    ? await db.unit.findUnique({ where: { id: unitId }, select: { id: true, zoneId: true, version: true } })
    : await db.unit.findFirst({
        where: { status: 'AVAILABLE' },
        select: { id: true, zoneId: true, version: true },
      });

  if (!unit) return { action: 'BREAK_UNIT', detail: 'no unit to break' };

  // Conditional on the version we read, like every other unit write in this
  // codebase: a chaos control that clobbered a concurrent dispatch would be
  // demonstrating a bug rather than a failure mode.
  const changed = await db.unit.updateMany({
    where: { id: unit.id, version: unit.version },
    data: { status: 'MAINTENANCE', version: { increment: 1 } },
  });
  if (changed.count === 0) {
    return { action: 'BREAK_UNIT', detail: `unit ${unit.id} changed underneath us; nothing done` };
  }

  await db.unitStatusHistory.create({
    data: { unitId: unit.id, toStatus: 'MAINTENANCE', reason: 'CHAOS_BREAK_UNIT' },
  });
  await enqueueSolve(unit.zoneId, 'CHAOS_UNIT_BROKEN');

  logger.warn({ unitId: unit.id }, 'chaos: unit broken mid-job');
  return { action: 'BREAK_UNIT', detail: `unit ${unit.id} is in MAINTENANCE` };
}

// A workshop says no. Recorded on the job's own event trail rather than as a
// side channel, because "the destination declined" is a fact about the job and
// an operator reading the timeline has to see it there.
export async function declineDestination(
  db: PrismaClient,
  jobId: string | null,
): Promise<ChaosActionResult> {
  const offer = jobId
    ? await db.destinationOffer.findFirst({ where: { jobId }, orderBy: { sentAt: 'desc' }, select: { id: true, jobId: true } })
    : await db.destinationOffer.findFirst({ orderBy: { sentAt: 'desc' }, select: { id: true, jobId: true } });

  if (!offer) return { action: 'DECLINE_DESTINATION', detail: 'no destination offer to decline' };

  await db.destinationOffer.updateMany({
    where: { id: offer.id, status: 'PROPOSED' },
    data: { status: 'DECLINED', respondedAt: new Date() },
  });
  await appendJobEvent(db, {
    jobId: offer.jobId,
    eventType: 'DESTINATION_DECLINED',
    payload: { offerId: offer.id, reason: 'CHAOS_FORCED_DECLINE' },
    actorRole: 'SYSTEM',
    actorId: null,
    at: new Date(),
  });

  logger.warn({ offerId: offer.id }, 'chaos: destination forced to decline');
  return { action: 'DECLINE_DESTINATION', detail: `destination offer ${offer.id} declined` };
}

// N breakdowns at once, through real intake. The point of the control is to
// watch the queue depth and the planner's wall clock move, so anything less
// than the real path would be measuring the wrong thing.
export async function injectJobs(db: PrismaClient, count: number): Promise<ChaosActionResult> {
  const driver = await db.driver.findFirst({
    where: { vehicles: { some: {} } },
    select: { id: true, tenantId: true, vehicles: { select: { id: true }, take: 1 } },
  });
  if (!driver) return { action: 'INJECT_JOBS', detail: 'no seeded driver with a vehicle' };

  const created: string[] = [];
  for (let index = 0; index < count; index++) {
    const result = await createIntakeJob(db, {
      driverId: driver.id,
      vehicleId: driver.vehicles[0]!.id,
      tenantId: driver.tenantId,
      symptoms: { primaryComplaint: 'FLAT_TYRE', engineCranks: null, warningLights: [], unusualSound: null, vehicleMoves: false },
      safety: { trafficSpeedKph: null, blockingLiveLane: false, smokeOrBurningSmell: false, fuelSmell: false, overheating: false, driverAlone: true, vulnerablePassengers: false },
      // Scattered slightly so they do not all land on one node of the routing
      // graph, which would make every travel time identical and the load test
      // meaningless.
      location: {
        lat: 12.93 + index * 0.002,
        lng: 77.62 + index * 0.002,
        roadPosition: 'SHOULDER',
        headingDegrees: null,
        accuracyMetres: null,
        nearestExit: null,
        kmMarker: null,
        landmark: null,
        parkingLevel: null,
      },
      actor: { role: 'SYSTEM', id: 'chaos' },
      at: new Date(),
    });
    created.push(result.jobId);
  }

  logger.warn({ count: created.length }, 'chaos: jobs injected');
  return { action: 'INJECT_JOBS', detail: `${created.length} jobs injected` };
}
