// THE TECHNICIAN'S BOARD — everything their phone needs about the job in hand.
//
// WHY THIS FILE EXISTS. `/technician/work` used to return nine fields: the job
// id, its status, the next rung, safety, zone, landmark, coordinates and the
// vehicle. Everything four later phases built for the person holding the
// spanner was invisible to them:
//
//   PHASE 13  a re-plan that released them wrote TECHNICIAN_RELEASED_FROM_JOB
//             and nothing read it. The job simply vanished off their board.
//   PHASE 15c the itemised estimate the driver is looking at, and the amount
//             the pause is waiting on.
//   PHASE 19  the part-sourcing decision — the driver is told "Ravi needs a
//             part", and Ravi was told nothing.
//   PHASE 22  the workshop a tow is going to, and why that one.
//
// None of this is new backend. Every row below was written by an earlier phase
// and simply never selected. The read model is assembled here rather than in
// the route so the route stays a route.
//
// NOTHING HERE DECIDES ANYTHING. No status is computed, no eligibility is
// judged; the ladder's next rung still comes from `nextStepFor` and the
// sourcing decision is read exactly as `persistSolverRun` wrote it.

import type { PrismaClient } from '@prisma/client';
import { nextStepFor } from '../domain/jobLadder.js';
import { technicianUpdatesFor, RELEASE_EVENTS, releaseSentenceFor } from '../domain/technicianUpdates.js';
import { inWords } from '../domain/vehicleWords.js';
import { readDuty } from './technicianDuty.js';

// The statuses a technician still has work to do on. A RESOLVED or CANCELLED
// job drops off their screen; the dispatcher keeps it.
//
// AWAITING_APPROVAL IS ON THIS LIST even though the technician cannot advance
// it. A paused job is still theirs — they are standing next to the car — and
// dropping it off the board would tell them it had been taken away.
export const OPEN_STATUSES = [
  'COMMITTED',
  'EN_ROUTE',
  'ON_SITE',
  'DIAGNOSING',
  'WORKING',
  'AWAITING_APPROVAL',
] as const;

// How far back a release notice stays on the board. Long enough that somebody
// who put the phone down mid-job still sees it; short enough that last week's
// reassignment is not on today's screen.
const RELEASE_WINDOW_MS = 6 * 60 * 60 * 1000;
const UPDATE_LIMIT = 12;

export async function buildTechnicianBoard(db: PrismaClient, technicianId: string) {
  const [offers, jobs, releases, duty] = await Promise.all([
    openOffers(db, technicianId),
    openJobs(db, technicianId),
    recentReleases(db, technicianId),
    // Rides along with the board rather than needing its own poll: it changes
    // rarely and is read on every render.
    readDuty(db, technicianId, new Date()),
  ]);

  const detailed = await Promise.all(jobs.map((job) => withContext(db, job)));
  return { offers, jobs: detailed, releases, duty };
}

// ---------------------------------------------------------------------------

async function openOffers(db: PrismaClient, technicianId: string) {
  const offers = await db.technicianOffer.findMany({
    where: { technicianId, status: 'PROPOSED', expiresAt: { gt: new Date() } },
    orderBy: { sentAt: 'asc' },
    select: {
      id: true,
      expiresAt: true,
      job: {
        select: {
          id: true,
          safetyLevel: true,
          landmark: true,
          roadPosition: true,
          zone: { select: { name: true } },
          vehicle: {
            select: { registration: true, profile: { select: { make: true, model: true } } },
          },
        },
      },
    },
  });

  return offers.map((offer) => ({
    offerId: offer.id,
    jobId: offer.job.id,
    // The deadline as an instant, never a countdown from the server: the page
    // derives seconds remaining from this and its own clock, so a slow response
    // shows a shorter countdown rather than a wrong one.
    expiresAt: offer.expiresAt.toISOString(),
    safetyLevel: offer.job.safetyLevel,
    zone: offer.job.zone.name,
    where: offer.job.landmark ?? offer.job.roadPosition ?? null,
    vehicle: describeVehicle(offer.job.vehicle),
  }));
}

async function openJobs(db: PrismaClient, technicianId: string) {
  return db.job.findMany({
    where: { assignedTechnicianId: technicianId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      status: true,
      safetyLevel: true,
      lat: true,
      lng: true,
      landmark: true,
      assignedUnitId: true,
      zone: { select: { name: true } },
      vehicle: { select: { registration: true, profile: { select: { make: true, model: true } } } },
      // WHO TO RING, from the technician's side. The other half of the call
      // affordance the driver has — a technician who cannot find a car in a
      // basement car park has exactly one useful action, and it is not chat.
      driver: { select: { user: { select: { name: true, phone: true } } } },
    },
  });
}

type OpenJob = Awaited<ReturnType<typeof openJobs>>[number];

async function withContext(db: PrismaClient, job: OpenJob) {
  const [estimate, option, destination, events, unit] = await Promise.all([
    latestEstimate(db, job.id),
    // The sourcing and destination decisions recorded for the crew this job was
    // actually given. Written by persistSolverRun; nothing is decided here.
    job.assignedUnitId
      ? db.dispatchOption.findFirst({
          where: { jobId: job.id, unitId: job.assignedUnitId, feasible: true },
          orderBy: { createdAt: 'desc' },
          select: { partSourcing: true, destination: true },
        })
      : null,
    chosenDestination(db, job.id),
    db.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { sequence: 'desc' },
      take: 40,
      select: { eventType: true, at: true },
    }),
    // THE TECHNICIAN'S OWN LAST POSITION, so their card can show the same map
    // the driver is looking at. Written by their own status taps — see
    // src/commit/unitPosition.ts.
    job.assignedUnitId
      ? db.unit.findUnique({
          where: { id: job.assignedUnitId },
          select: { lat: true, lng: true, lastLocationAt: true },
        })
      : null,
  ]);

  return {
    jobId: job.id,
    status: job.status,
    nextStep: nextStepFor(job.status),
    safetyLevel: job.safetyLevel,
    zone: job.zone.name,
    landmark: job.landmark,
    lat: job.lat,
    lng: job.lng,
    // The pair of points the job card's map draws: where the car is, and where
    // this crew last reported being. Same shape the driver's view sends, so the
    // two surfaces render through one component.
    tracking:
      typeof job.lat === 'number' && typeof job.lng === 'number'
        ? {
            you: unit && typeof unit.lat === 'number' && typeof unit.lng === 'number'
              ? { lat: unit.lat, lng: unit.lng }
              : null,
            job: { lat: job.lat, lng: job.lng },
          }
        : null,
    vehicle: describeVehicle(job.vehicle),
    // First name only, the same rule the driver's screen follows in the other
    // direction: enough to greet somebody by, not a personnel record.
    driver: {
      name: job.driver.user.name?.split(' ')[0] ?? 'the driver',
      phone: job.driver.user.phone,
    },
    estimate,
    partSourcing: readSourcing(option?.partSourcing),
    destination,
    updates: technicianUpdatesFor([...events].reverse()).slice(-UPDATE_LIMIT),
  };
}

// WHAT THE DRIVER IS LOOKING AT. The same lines, the same total — a technician
// standing next to somebody deciding whether to approve a cost should be able
// to see the cost.
async function latestEstimate(db: PrismaClient, jobId: string) {
  const estimate = await db.estimate.findFirst({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
    select: {
      status: true,
      totalPaise: true,
      coveredPaise: true,
      lines: {
        select: { description: true, quantity: true, amountPaise: true },
        orderBy: { id: 'asc' },
      },
      approval: { select: { approvedAt: true, approvedAmountPaise: true } },
    },
  });
  if (!estimate) return null;

  return {
    status: estimate.status,
    totalPaise: estimate.totalPaise,
    // Payable is total minus what a contract absorbs. Derived, never stored —
    // two figures that must sum to a third are two chances to disagree.
    payablePaise: estimate.totalPaise - estimate.coveredPaise,
    lines: estimate.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      amountPaise: line.amountPaise,
    })),
    approvedAt: estimate.approval?.approvedAt?.toISOString() ?? null,
  };
}

// WHERE THIS TOW IS GOING, AND WHY THAT WORKSHOP. A bare address tells a
// technician nothing about whether to argue with it; "authorised for this
// brand, 18 minutes away" does.
async function chosenDestination(db: PrismaClient, jobId: string) {
  const offer = await db.destinationOffer.findFirst({
    where: { jobId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
    orderBy: { sentAt: 'desc' },
    select: {
      status: true,
      etaSeconds: true,
      workshop: {
        select: {
          name: true,
          code: true,
          authorisations: { select: { brand: true, level: true } },
        },
      },
    },
  });
  if (!offer) return null;

  return {
    name: offer.workshop.name,
    code: offer.workshop.code,
    status: offer.status,
    etaSeconds: offer.etaSeconds,
    authorisedBrands: offer.workshop.authorisations.map((row) => inWords(row.brand) ?? row.brand),
  };
}

// The stored sourcing decision is JSON, so it is read defensively rather than
// cast — an option written before Phase 19 has no `part_sourcing` at all, and a
// technician's screen is the last place that should throw over a null column.
function readSourcing(stored: unknown): { status: string; detail: string | null } | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const record = stored as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : null;
  if (!status) return null;
  return {
    status,
    detail: typeof record.reason === 'string' ? record.reason : null,
  };
}

// A RELEASE IS NOT A LINE IN A LIST. It is the one thing on this screen that
// has to interrupt somebody, so it is returned separately from the job feed —
// and it has to be, because by the time it matters the job is no longer on
// their board to carry it.
async function recentReleases(db: PrismaClient, technicianId: string) {
  const events = await db.jobEvent.findMany({
    where: {
      eventType: { in: [...RELEASE_EVENTS] },
      at: { gt: new Date(Date.now() - RELEASE_WINDOW_MS) },
      payload: { path: ['technicianId'], equals: technicianId },
    },
    orderBy: { at: 'desc' },
    take: 3,
    select: { jobId: true, eventType: true, at: true },
  });

  return events.map((event) => ({
    jobId: event.jobId,
    at: event.at.toISOString(),
    text: releaseSentenceFor(event.eventType) ?? 'This job was reassigned.',
  }));
}

function describeVehicle(
  vehicle: { registration: string; profile: { make: string; model: string } | null } | null,
): string {
  if (!vehicle) return 'unknown vehicle';
  const profile = vehicle.profile;
  // `MARUTI_SUZUKI` is a database value; "Maruti Suzuki" is a car. The same
  // rule the driver's surfaces follow — see src/domain/vehicleWords.ts.
  return profile
    ? `${inWords(profile.make)} ${profile.model} · ${vehicle.registration}`
    : vehicle.registration;
}
