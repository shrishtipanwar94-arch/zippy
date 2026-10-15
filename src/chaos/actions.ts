// THE CONTROLS THAT ARE EVENTS, NOT MODES.
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
  'ADVANCE_TIME',
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
// MOVING THE BOARD THROUGH TIME, BY AGEING THE DATA RATHER THAN THE CLOCK.
//
// A demo is hostage to real time: an offer lives forty-five seconds, an SLA
// window thirty minutes, a position goes stale after fifteen. Showing a window
// close means talking over a static screen for half an hour.
//
// WHY NOT A CLOCK ABSTRACTION. The obvious fix is to inject a clock and let a
// multiplier speed it up. There are sixty-eight `new Date()` call sites across
// thirty files, and every one of them would have to change — a cross-cutting
// refactor of the whole codebase, risking the determinism the evaluation
// harness depends on (invariant 10), to serve a demo control.
//
// It is also unnecessary, because every time-dependent behaviour in this system
// has the same shape: read `now`, compare it against a stored timestamp.
// `escalateClosedSlaWindows` compares `job.createdAt` against the policy
// window; the GPS probe compares `unit.lastLocationAt` against
// POSITION_STALE_AFTER_MS; an offer compares `expiresAt`. Moving those stored
// timestamps BACKWARDS is indistinguishable, to every one of those readers,
// from moving the clock forwards — and it touches four columns instead of
// sixty-eight call sites.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH: `job_events`. That table is append-only,
// enforced by a database trigger, and it should be — the timeline is the
// truthful record of when things actually happened, and a demo control that
// rewrote history would make the one artefact you would show an interviewer
// untrustworthy. So the story panel keeps real wall-clock times while the
// board's behaviour moves. An ordinary JobEvent records that this was used, so
// the gap between the two is explained on the timeline rather than mysterious.
//
// `onlyJobIds` EXISTS FOR TESTS AND THE PRODUCTION CALLER NEVER PASSES IT. This
// function operates on EVERYTHING, and `zippy_test` is shared by suites running
// in parallel — an unscoped call here would age another file's jobs out of
// their SLA windows mid-assertion. The project has lost afternoons to exactly
// that shape before (see CLAUDE.md), so the scope hatch is part of the design
// rather than a concession.
export async function advanceTime(
  db: PrismaClient,
  minutes: number,
  onlyJobIds?: string[],
): Promise<ChaosActionResult> {
  const shiftMs = minutes * 60 * 1000;
  const shift = (at: Date) => new Date(at.getTime() - shiftMs);

  // Only jobs still in play. Ageing a RESOLVED job changes nothing anybody can
  // see and would corrupt the earnings and settlement history underneath it.
  const live = await db.job.findMany({
    where: {
      status: { notIn: ['RESOLVED', 'CANCELLED'] },
      ...(onlyJobIds ? { id: { in: onlyJobIds } } : {}),
    },
    select: { id: true, createdAt: true },
  });
  for (const job of live) {
    await db.job.update({ where: { id: job.id }, data: { createdAt: shift(job.createdAt) } });
  }

  const offers = await db.technicianOffer.findMany({
    where: { status: 'PROPOSED', ...(onlyJobIds ? { jobId: { in: onlyJobIds } } : {}) },
    select: { id: true, expiresAt: true },
  });
  for (const offer of offers) {
    await db.technicianOffer.update({
      where: { id: offer.id },
      data: { expiresAt: shift(offer.expiresAt) },
    });
  }

  // Units are fleet-wide and have no job to scope by, so a scoped call leaves
  // them alone entirely rather than ageing every other suite's fleet.
  const units = onlyJobIds
    ? []
    : await db.unit.findMany({
        where: { lastLocationAt: { not: null } },
        select: { id: true, lastLocationAt: true },
      });
  for (const unit of units) {
    if (!unit.lastLocationAt) continue;
    await db.unit.update({
      where: { id: unit.id },
      data: { lastLocationAt: shift(unit.lastLocationAt) },
    });
  }

  // ON THE TIMELINE, so the difference between a job's shifted age and its
  // truthful event times is explained where somebody reading the job will see
  // it, rather than looking like a bug.
  for (const job of live) {
    await appendJobEvent(db, {
      jobId: job.id,
      eventType: 'DEMO_TIME_ADVANCED',
      payload: { minutes },
      actorRole: 'SYSTEM',
      actorId: 'chaos',
    });
  }

  logger.warn({ minutes, jobs: live.length, offers: offers.length }, 'chaos: time advanced');
  return {
    action: 'ADVANCE_TIME',
    detail: `advanced ${minutes} minutes: ${live.length} live jobs, ${offers.length} open offers and ${units.length} unit positions are now that much older`,
  };
}

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
        lat: 28.61 + index * 0.002,
        lng: 77.205 + index * 0.002,
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
