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
  formatIstClock,
  labelForUnit,
  whatWeThinkItIs,
} from '../domain/driverNarrative.js';
import { driverUpdatesFor } from '../domain/driverUpdates.js';
import { guidanceFor } from '../domain/safetyGuidance.js';
import { contendingFaults } from '../domain/capabilitySet.js';
import { isFaultCode } from '../domain/faults.js';
import type { FaultCode, FaultDistribution } from '../domain/faults.js';

export const driverRouter = Router();

// The re-dispatch actions that mean "we are arranging different help". An open
// one of these is what the driver's REPLANNING sentence is driven by — the
// same rows the dispatcher's action queue shows, read from the driver's side.
const REPLANNING_KINDS = ['REASSIGN_AFTER_DIAGNOSIS_CHANGE', 'REASSIGN_AFTER_TRIGGER'];

// Only the last few updates. A driver wants to know what is happening now, not
// to audit the incident — that is the dispatcher's timeline.
const UPDATE_LIMIT = 12;

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
      select: { id: true, status: true, safetyLevel: true, createdAt: true },
    });
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Everything below hangs off a job id the scoped read has already proved
    // the caller owns, so the unscoped client is correct here — the same
    // division intake.ts uses.
    const [helper, hypothesis, eta, verification, estimate, events, replanning] = await Promise.all([
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
        where: { jobId: job.id },
        orderBy: { createdAt: 'desc' },
        select: { totalPaise: true, lines: { select: { description: true, amountPaise: true } } },
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
    ]);

    const arrivingAt = eta ? new Date(eta.computedAt.getTime() + eta.etaSeconds * 1000) : null;
    const intakeComplete = events.some((event) => event.eventType === 'INTAKE_COMPLETED');

    res.json({
      jobId: job.id,
      reportedAt: job.createdAt.toISOString(),
      headline: headlineFor({
        status: job.status,
        helperName: helper?.name ?? null,
        arrivingAt,
        replanning: replanning > 0,
        intakeComplete,
      }),
      detail: whatWeThinkItIs(contendersFrom(hypothesis?.distribution)),
      arrival: arrivalView(arrivingAt, eta?.degraded ?? false),
      helper,
      guidance: guidanceFor(job.safetyLevel),
      estimate: estimateView(estimate),
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
): Promise<{ name: string; vehicle: string | null } | null> {
  const job = await prismaBase.job.findUnique({
    where: { id: jobId },
    select: {
      assignedTechnician: { select: { user: { select: { name: true } } } },
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

function arrivalView(
  arrivingAt: Date | null,
  degraded: boolean,
): { at: string; clock: string; rough: boolean } | null {
  if (!arrivingAt) return null;
  return {
    at: arrivingAt.toISOString(),
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
// GENERATING estimates is the money domain's job (Phase 15c) and nothing
// writes an `estimates` row yet, so today this reads null on every real job.
// The read path is built and covered by a test that inserts one, because the
// ordering rule — cost before confirmation — is a Phase 15 promise about this
// screen, and retrofitting it after payment exists is how it gets forgotten.
function estimateView(
  estimate: { totalPaise: number; lines: { description: string; amountPaise: number }[] } | null,
): { lines: { description: string; amount: string }[]; total: string } | null {
  if (!estimate) return null;
  return {
    lines: estimate.lines.map((line) => ({
      description: line.description,
      amount: rupees(line.amountPaise),
    })),
    total: rupees(estimate.totalPaise),
  };
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

// Money is integer paise everywhere in this codebase. This is the only place a
// driver sees it, so it is the only place it becomes rupees.
function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
