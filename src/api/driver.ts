// GET /jobs/:id/driver-view — everything the driver's phone shows, already in
// English.
//
// ONE ENDPOINT, TRANSLATED SERVER-SIDE. The obvious alternative is to let the
// browser read /jobs/:id and translate there, and it is worse for one reason:
// "no enum ever reaches a driver" then lives in template code that nobody can
// test. Here it is a property of this response body, and
// tests/driverSurface.test.ts asserts it by scanning the whole payload for
// SCREAMING_CASE. The phase check — "read it as a stranger; any SCREAMING_CASE
// word is a bug" — becomes something the suite can enforce.
//
// ZERO NEW BACKEND, as the brief requires. Every field below is read from what
// earlier phases already wrote: the job row, the latest fault hypothesis, the
// latest ETA estimate, the completion code, the estimate lines, the job event
// trail. Nothing is computed, decided or stored here.
//
// AUTHORISATION IS THE SCOPED CLIENT'S JOB. `prisma` narrows a DRIVER to their
// own jobs (permissions.jobReadOwnershipFilter), so another driver's id simply
// resolves to nothing and this returns 404 — never 403, which would confirm
// the job exists.

import { Router } from 'express';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import {
  headlineFor,
  formatArrivalIn,
  formatIstClock,
  labelForJobStatus,
  labelForUnit,
  stagesFor,
  whatWeThinkItIs,
} from '../domain/driverNarrative.js';
import { driverUpdatesFor } from '../domain/driverUpdates.js';
import { guidanceFor } from '../domain/safetyGuidance.js';
// Money is integer paise everywhere; src/domain/money.ts is the one place it
// becomes words, so the driver's screen and an invoice cannot format it
// differently.
import { formatRupees } from '../domain/money.js';
import { approvedTotalFor } from '../commit/estimates.js';
import { describePositionAge } from '../commit/unitPosition.js';
import { contendingFaults } from '../domain/capabilitySet.js';
import { isFaultCode } from '../domain/faults.js';
import type { FaultCode, FaultDistribution } from '../domain/faults.js';

export const driverRouter = Router();

// The statuses during which "when will they get here" is still the driver's
// question. Once the crew is on site it has been answered by their being there.
const STILL_ARRIVING: ReadonlySet<string> = new Set([
  'PLANNED',
  'OFFERED',
  'COMMITTED',
  'EN_ROUTE',
]);

// The re-dispatch actions that mean "we are arranging different help". An open
// one of these is what the driver's REPLANNING sentence is driven by — the
// same rows the dispatcher's action queue shows, read from the driver's side.
const REPLANNING_KINDS = ['REASSIGN_AFTER_DIAGNOSIS_CHANGE', 'REASSIGN_AFTER_TRIGGER'];

// Only the last few updates. A driver wants to know what is happening now, not
// to audit the incident — that is the dispatcher's timeline.
const UPDATE_LIMIT = 12;

// The stored sourcing decision is JSON, so it is read defensively rather than
// cast — an option written before Phase 19 has no `part_sourcing` at all, and
// a driver's screen is the last place that should throw over a null column.
function isWorkshopRun(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  return (stored as { status?: unknown }).status === 'WORKSHOP_RUN';
}

// A JOB THE DRIVER HAS NOT FINISHED WITH. Counted out rather than in, the same
// direction src/api/console.ts counts them: a status added by a later phase
// shows up as open, and the failure is a driver being offered a job that has
// ended rather than being unable to reach one that has not.
const FINISHED_JOB_STATUSES = ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] as const;

// WHAT THIS DRIVER STILL HAS OPEN — the list the phone needs to find its way
// back after a reload.
//
// The driver page used to hold the job id only in memory, set at the moment it
// created one, so locking the phone or dropping the browser tab dumped a driver
// with a technician already en route back onto "What has happened?". This is the
// one surface where the person using it is guaranteed to be having a bad day,
// and a lost session is a second problem on top of the first.
//
// SERVER-SIDE, and worded here, for the reason the whole file exists: the
// browser must not own a second copy of "which statuses are finished" or of how
// a status is spelled in English. Both already live here.
driverRouter.get(
  '/driver/open-jobs',
  authenticate,
  requirePermission('read', 'job'),
  async (_req, res) => {
    // The scoped client narrows a DRIVER to their own jobs, so there is no
    // driver id in this query and no way to ask for somebody else's.
    const jobs = await prisma.job.findMany({
      where: { status: { notIn: [...FINISHED_JOB_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        status: true,
        createdAt: true,
        vehicle: { select: { registration: true } },
      },
    });

    res.json({
      jobs: jobs.map((job) => ({
        jobId: job.id,
        // The plate, because that is what a driver with two cars is choosing
        // between — not a cuid and not a status.
        registration: job.vehicle.registration,
        status: labelForJobStatus(job.status),
        raisedAt: job.createdAt.toISOString(),
      })),
    });
  },
);

driverRouter.get(
  '/jobs/:id/driver-view',
  authenticate,
  requirePermission('read', 'job'),
  async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const job = await prisma.job.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        safetyLevel: true,
        createdAt: true,
        assignedUnitId: true,
        // Where the driver is. The map needs both ends of the journey, and this
        // end is the one the driver themselves gave us at intake.
        lat: true,
        lng: true,
      },
    });
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Everything below hangs off a job id the scoped read has already proved
    // the caller owns, so the unscoped client is correct here — the same
    // division intake.ts uses.
    const [
      helper,
      hypothesis,
      eta,
      verification,
      estimate,
      events,
      replanning,
      approvedTotalPaise,
      sourcing,
      unit,
    ] = await Promise.all([
      assignedHelper(job.id),
      prismaBase.faultHypothesis.findFirst({
        where: { jobId: job.id },
        orderBy: { createdAt: 'desc' },
        select: { distribution: true },
      }),
      prismaBase.etaEstimate.findFirst({
        where: { jobId: job.id },
        orderBy: { computedAt: 'desc' },
        select: { etaSeconds: true, computedAt: true, degraded: true },
      }),
      prismaBase.completionVerification.findUnique({
        where: { jobId: job.id },
        select: { code: true, verifiedAt: true },
      }),
      prismaBase.estimate.findFirst({
        // A superseded estimate is a record, not something the driver answers.
        where: { jobId: job.id, supersededAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          totalPaise: true,
          coveredPaise: true,
          lines: { select: { description: true, amountPaise: true } },
        },
      }),
      prismaBase.jobEvent.findMany({
        where: { jobId: job.id },
        orderBy: { sequence: 'desc' },
        take: 40,
        select: { eventType: true, at: true },
      }),
      prismaBase.actionRequest.count({
        where: { jobId: job.id, status: 'PENDING', kind: { in: REPLANNING_KINDS } },
      }),
      approvedTotalFor(prismaBase, job.id),
      // The sourcing decision recorded for the crew this job was actually
      // given. Still zero new backend: persistSolverRun wrote this row when it
      // made the choice, and nothing is computed or decided here.
      job.assignedUnitId
        ? prismaBase.dispatchOption.findFirst({
            where: { jobId: job.id, unitId: job.assignedUnitId, feasible: true },
            orderBy: { createdAt: 'desc' },
            select: { partSourcing: true },
          })
        : Promise.resolve(null),
      // The crew's last recorded position, for the map. Written by their own
      // status taps — see src/commit/unitPosition.ts.
      job.assignedUnitId
        ? prismaBase.unit.findUnique({
            where: { id: job.assignedUnitId },
            select: { lat: true, lng: true, lastLocationAt: true },
          })
        : Promise.resolve(null),
    ]);

    const arrivingAt = eta ? new Date(eta.computedAt.getTime() + eta.etaSeconds * 1000) : null;
    const intakeComplete = events.some((event) => event.eventType === 'INTAKE_COMPLETED');
    const sourcingPart = isWorkshopRun(sourcing?.partSourcing);

    res.json({
      jobId: job.id,
      reportedAt: job.createdAt.toISOString(),
      headline: headlineFor({
        status: job.status,
        helperName: helper?.name ?? null,
        arrivingAt,
        replanning: replanning > 0,
        sourcingPart,
        intakeComplete,
      }),
      detail: whatWeThinkItIs(contendersFrom(hypothesis?.distribution)),
      // ONLY WHILE THEY ARE STILL COMING. An arrival estimate above the words
      // "Anil is working on your vehicle now" is not just redundant, it is
      // wrong — the number is in the past and the driver has to work out that
      // it no longer applies.
      arrival: STILL_ARRIVING.has(job.status)
        ? arrivalView(arrivingAt, eta?.degraded ?? false)
        : null,
      tracking: trackingView(job, unit, new Date()),
      // Already worded and already flagged — the phone renders this list and
      // owns no stage vocabulary of its own.
      stages: stagesFor(job.status),
      helper,
      guidance: guidanceFor(job.safetyLevel),
      estimate: withDeclineOption(estimateView(estimate), approvedTotalPaise),
      completionCode: completionCodeView(verification),
      // Oldest first: the driver reads this like a story, not like a log.
      updates: driverUpdatesFor([...events].reverse()).slice(-UPDATE_LIMIT),
    });
  },
);

// The person coming, in the words a driver would use. First name only — it is
// what a stranger arriving at your car introduces themselves with, and the
// employee code is nobody's business but the dispatcher's.
async function assignedHelper(
  jobId: string,
): Promise<{ name: string; vehicle: string | null; phone: string | null } | null> {
  const job = await prismaBase.job.findUnique({
    where: { id: jobId },
    select: {
      assignedTechnician: { select: { user: { select: { name: true, phone: true } } } },
      assignedUnit: { select: { kind: true } },
    },
  });
  const fullName = job?.assignedTechnician?.user.name;
  if (!fullName) return null;

  const unitKind = job?.assignedUnit?.kind;
  return {
    name: fullName.split(' ')[0] ?? fullName,
    // What is coming, not which asset it is. The unit CODE is a fleet
    // identifier — the driverSurface test caught it leaking onto this screen,
    // which is exactly what that scan is for.
    vehicle: unitKind ? labelForUnit(unitKind) : null,
    // SO THE DRIVER CAN RING THEM. A `tel:` link and a real number, which is
    // deliberate headroom rather than a finished answer — see docs/UI.md: a
    // production build masks both parties through a relay so neither keeps the
    // other's number after the job.
    phone: job?.assignedTechnician?.user.phone ?? null,
  };
}

function contendersFrom(distribution: unknown): FaultCode[] {
  if (!distribution || typeof distribution !== 'object') return [];
  const entries = Object.entries(distribution as Record<string, unknown>);
  if (entries.every(([fault, weight]) => isFaultCode(fault) && typeof weight === 'number')) {
    return contendingFaults(distribution as FaultDistribution);
  }
  return [];
}

// THE MAP'S DATA, AND ITS HONESTY.
//
// Two points and a sentence about how much to trust the second one. The
// driver's own position comes from intake; the crew's comes from their last
// status tap, which means it is minutes old rather than seconds old and the
// screen has to say so.
//
// NULL RATHER THAN A GUESS. No assigned crew, no recorded position, or no
// coordinates for the breakdown itself — any of those and there is no map. An
// empty space is honest; a dot in the middle of the city is not.
function trackingView(
  job: { lat: number | null; lng: number | null; status: string },
  unit: { lat: number | null; lng: number | null; lastLocationAt: Date | null } | null,
  now: Date,
): {
  you: { lat: number; lng: number };
  helper: { lat: number; lng: number } | null;
  note: string | null;
  stale: boolean;
} | null {
  if (typeof job.lat !== 'number' || typeof job.lng !== 'number') return null;

  const you = { lat: job.lat, lng: job.lng };

  // Once the crew is on site the map has stopped answering a question. Their
  // dot and the driver's are the same place, and "last seen 3 minutes ago"
  // beside somebody standing next to you is noise.
  if (!STILL_ARRIVING.has(job.status)) return { you, helper: null, note: null, stale: false };

  if (!unit || typeof unit.lat !== 'number' || typeof unit.lng !== 'number') {
    return { you, helper: null, note: 'We do not have their position yet.', stale: true };
  }

  const age = describePositionAge(unit.lastLocationAt, now);
  return { you, helper: { lat: unit.lat, lng: unit.lng }, note: age.text, stale: age.stale };
}

function arrivalView(
  arrivingAt: Date | null,
  degraded: boolean,
): { at: string; inWords: string; clock: string; rough: boolean } | null {
  if (!arrivingAt) return null;
  return {
    at: arrivingAt.toISOString(),
    // HOW LONG, not what time — the figure the phone puts at the top of the
    // card. See formatArrivalIn for why this is not the countdown the brief
    // rules out.
    inWords: formatArrivalIn(arrivingAt, new Date()),
    // Kept alongside it: the absolute time is what a driver reads back to
    // somebody on the phone, and it is the only honest thing to show once the
    // relative figure has gone stale in a backgrounded tab.
    clock: formatIstClock(arrivingAt),
    // Invariant 8: a degraded estimate is visible rather than silently
    // substituted. On this surface it becomes "this is a rough time", not a
    // reason code.
    rough: degraded,
  };
}

// The itemised estimate, shown BEFORE the completion code is entered — the
// driver knows what the work costs before confirming it was done.
//
// FROM PHASE 15c STAGE 2 THIS IS ALSO A QUESTION, not only a statement. An
// estimate still SENT is one the technician is waiting on, and `awaitingAnswer`
// is what turns the card into approve / decline / cancel. Whether the driver
// may actually answer is the server's decision on the respond route; this only
// says whether there is anything to answer.
function estimateView(
  estimate: {
    id: string;
    status: string;
    totalPaise: number;
    coveredPaise: number;
    lines: { description: string; amountPaise: number }[];
  } | null,
): {
  estimateId: string;
  lines: { description: string; amount: string }[];
  total: string;
  // THE HALF A COVERED CUSTOMER ACTUALLY CARES ABOUT. `covered` is null when
  // nothing is absorbed, so a walk-in's card stays a single total rather than
  // growing a "covered ₹0" line that means nothing to them.
  covered: string | null;
  payable: string;
  fullyCovered: boolean;
  awaitingAnswer: boolean;
  // Declining means "finish at the scope I already agreed", so it is only
  // offered when there IS a prior approval. Computed by the caller, which is
  // the only place that knows.
  mayDecline: boolean;
} | null {
  if (!estimate) return null;
  const payablePaise = estimate.totalPaise - estimate.coveredPaise;
  return {
    estimateId: estimate.id,
    lines: estimate.lines.map((line) => ({
      description: line.description,
      amount: formatRupees(line.amountPaise),
    })),
    total: formatRupees(estimate.totalPaise),
    covered: estimate.coveredPaise > 0 ? formatRupees(-estimate.coveredPaise) : null,
    payable: formatRupees(payablePaise),
    fullyCovered: payablePaise === 0,
    awaitingAnswer: estimate.status === 'SENT',
    mayDecline: false,
  };
}

// DECLINE IS ONLY OFFERED WHEN THERE IS SOMETHING TO FALL BACK TO. Declining
// the first estimate would leave the job paused with no approved scope to
// finish, so the server refuses it — and a button that always fails is worse
// than no button.
function withDeclineOption(
  view: ReturnType<typeof estimateView>,
  approvedTotalPaise: number | null,
): ReturnType<typeof estimateView> {
  if (!view) return null;
  return { ...view, mayDecline: view.awaitingAnswer && approvedTotalPaise !== null };
}

function completionCodeView(
  verification: { code: string; verifiedAt: Date | null } | null,
): { code: string; explain: string } | null {
  if (!verification || verification.verifiedAt) return null;
  return {
    // Grouped in threes because it is read aloud, once, to somebody standing
    // next to a running road.
    code: `${verification.code.slice(0, 3)} ${verification.code.slice(3)}`,
    explain: 'Read this out to your technician only once the work is finished.',
  };
}

