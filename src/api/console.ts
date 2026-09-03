// THE DISPATCH CONSOLE'S TWO READ ENDPOINTS.
//
// Both are pure reads over data earlier phases already wrote. Nothing here
// computes a decision, re-scores an option or re-runs a solve — the console's
// whole value is that it renders what the engine already recorded, so what a
// dispatcher sees is what actually happened rather than a second opinion
// generated at render time.
//
// GET  /events                  the incident timeline: job_events, filterable
// GET  /jobs/:id/decision       "why this technician?" for one job
// GET  /capabilities/scarcity   how thin the fleet is on each skill
// GET  /queue                   pending jobs, safety-first
// POST /plans/:id/select        a dispatcher takes a plan; an override explains itself
//
// Only the last of the five writes anything.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { summarise, byUrgency } from '../domain/scarcity.js';
import { orderQueue, slaRisk, ageMinutes } from '../domain/priority.js';
import { selectPlan, latestDecisionFor, RECOMMENDED_PLAN } from '../commit/decisionRecords.js';
import { PAYMENT_PENDING_AFTER_MS } from '../health/probes.js';
import { formatRupees } from '../domain/money.js';

export const consoleRouter = Router();

// A console showing "everything" is a console nobody can read, and an
// unbounded query over an append-only table gets slower every day.
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 500;

consoleRouter.get(
  '/events',
  authenticate,
  requirePermission('read', 'job'),
  async (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    const zoneId = typeof req.query.zoneId === 'string' ? req.query.zoneId : undefined;
    const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : undefined;

    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_EVENT_LIMIT)
      : DEFAULT_EVENT_LIMIT;

    // Zone is a property of the JOB, not of the event, so filtering by zone is
    // a relation filter rather than a column one. Kept server-side because
    // fetching every event and filtering in the browser is how a console
    // becomes unusable at exactly the moment it matters.
    const events = await prismaBase.jobEvent.findMany({
      where: {
        ...(jobId ? { jobId } : {}),
        ...(eventType ? { eventType } : {}),
        ...(zoneId ? { job: { is: { zoneId } } } : {}),
      },
      orderBy: { at: 'desc' },
      take: limit,
      select: {
        id: true,
        jobId: true,
        sequence: true,
        eventType: true,
        payload: true,
        actorRole: true,
        at: true,
        job: { select: { zoneId: true, safetyLevel: true, status: true } },
      },
    });

    // The filter options a dispatcher can choose from, derived from what is
    // actually in the table rather than from a hardcoded list that drifts as
    // phases add event types.
    const [types, zones] = await Promise.all([
      prismaBase.jobEvent.groupBy({ by: ['eventType'], _count: true }),
      prismaBase.zone.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    res.json({
      events: events.map((event) => ({
        id: event.id,
        jobId: event.jobId,
        sequence: event.sequence,
        eventType: event.eventType,
        payload: event.payload,
        actorRole: event.actorRole,
        at: event.at.toISOString(),
        zoneId: event.job.zoneId,
        safetyLevel: event.job.safetyLevel,
        jobStatus: event.job.status,
      })),
      eventTypes: types
        .map((row) => ({ eventType: row.eventType, count: row._count }))
        .sort((a, b) => b.count - a.count),
      zones,
      limit,
    });
  },
);

// ---------------------------------------------------------------------------
// WHY THIS TECHNICIAN?
//
// From Stage 2 this is answerable two ways, and the response says which.
// When a dispatcher has selected a plan there is a DecisionRecord, so the
// screen shows what a HUMAN chose — with their override reason if they
// departed from the recommendation. When nobody has selected anything it falls
// back to the solver's own reasoning, which is still true but is a proposal
// rather than a decision. `runSource` names which of the two is on screen.
consoleRouter.get(
  '/jobs/:id/decision',
  authenticate,
  requirePermission('read', 'solverRun'),
  async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const job = await prismaBase.job.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        safetyLevel: true,
        zoneId: true,
        assignedUnitId: true,
        assignedTechnicianId: true,
        faultHypotheses: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { distribution: true, requiredCapabilityCodes: true, topFault: true, entropy: true },
        },
      },
    });
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // WHICH RUN EXPLAINS THIS JOB'S CURRENT ASSIGNMENT.
    //
    // Stage 1 answered "the most recent run that touched this job", which is
    // the wrong question and was wrong more often after Phase 13: a zone
    // re-plan touches every pending job in the zone without changing who is
    // going to any of them, so the newest run is routinely a run that decided
    // nothing about this job.
    //
    // The authoritative answer is the DecisionRecord written when a dispatcher
    // selected a plan. Falling back, in order:
    //   1. the decision record's run — what a human actually chose
    //   2. the newest run that produced a FEASIBLE option matching the job's
    //      current assignment — the run whose plan the assignment came from
    //   3. the newest run that considered the job at all — for a job with no
    //      assignment yet, where the last solve genuinely is the live answer
    const decision = await latestDecisionFor(prismaBase, id);
    const solverRunId =
      decision.solverRunId ?? (await runBehindAssignment(id, job)) ?? (await newestRunFor(id));

    if (!solverRunId) {
      res.json({
        job,
        solverRun: null,
        chosen: [],
        rejected: [],
        hypothesis: job.faultHypotheses[0] ?? null,
        decisionRecord: null,
        overrideReasonCode: null,
        runSource: 'none',
      });
      return;
    }

    const [solverRun, options] = await Promise.all([
      prismaBase.solverRun.findUnique({
        where: { id: solverRunId },
        select: {
          id: true,
          trigger: true,
          createdAt: true,
          optionCount: true,
          feasibleCount: true,
          wallClockMs: true,
          zonePartitioned: true,
          snapshotHash: true,
        },
      }),
      prismaBase.dispatchOption.findMany({
        where: { solverRunId, jobId: id },
        select: {
          id: true,
          unitId: true,
          technicianId: true,
          feasible: true,
          rejectionCode: true,
          rejectionDetail: true,
          estimatedTravelMinutes: true,
          coveredFaultProbability: true,
          missingCapabilities: true,
          partSourcing: true,
          destination: true,
          costBreakdown: true,
          totalCost: true,
        },
      }),
    ]);

    res.json({
      job: {
        id: job.id,
        status: job.status,
        safetyLevel: job.safetyLevel,
        zoneId: job.zoneId,
        assignedUnitId: job.assignedUnitId,
        assignedTechnicianId: job.assignedTechnicianId,
      },
      hypothesis: job.faultHypotheses[0] ?? null,
      solverRun,
      // Split here rather than in the browser: "chosen" and "rejected" are two
      // different questions and the panel renders them differently.
      chosen: options.filter((candidate) => candidate.feasible),
      rejected: options.filter((candidate) => !candidate.feasible),
      // From Stage 2 this can be a real record. When it is, the screen is
      // showing what a HUMAN chose and why they differed from the
      // recommendation; when it is null, it is showing what the solver
      // proposed and nobody has committed to.
      decisionRecord: decision.decisionRecordId,
      overrideReasonCode: decision.overrideReasonCode,
      runSource: decision.solverRunId
        ? 'decision-record'
        : job.assignedUnitId
          ? 'current-assignment'
          : 'latest-solve',
    });
  },
);

// ---------------------------------------------------------------------------
// Which solver run actually produced the assignment a job is carrying now.
// Matched on the UNIT rather than on recency: the run whose plan put this unit
// on this job is the one that explains it, however many zone re-plans have
// happened since without touching it.
async function runBehindAssignment(
  jobId: string,
  job: { assignedUnitId: string | null },
): Promise<string | null> {
  if (!job.assignedUnitId) return null;
  const option = await prismaBase.dispatchOption.findFirst({
    where: { jobId, unitId: job.assignedUnitId, feasible: true },
    orderBy: { solverRun: { createdAt: 'desc' } },
    select: { solverRunId: true },
  });
  return option?.solverRunId ?? null;
}

async function newestRunFor(jobId: string): Promise<string | null> {
  const option = await prismaBase.dispatchOption.findFirst({
    where: { jobId },
    orderBy: { solverRun: { createdAt: 'desc' } },
    select: { solverRunId: true },
  });
  return option?.solverRunId ?? null;
}

// ---------------------------------------------------------------------------
// CAPABILITY SCARCITY — the coupled constraint made visible.
//
// Two EV certifications against twenty-four units is the reason an EV job can
// be unservable while half the fleet sits idle. A dispatcher who cannot see
// that has no way to anticipate it.
consoleRouter.get(
  '/capabilities/scarcity',
  authenticate,
  requirePermission('read', 'unit'),
  async (_req, res) => {
    const [capabilities, units, technicians] = await Promise.all([
      prismaBase.capability.findMany({ select: { code: true }, orderBy: { code: 'asc' } }),
      prismaBase.unit.findMany({
        where: { status: { not: 'OFFLINE' } },
        select: {
          id: true,
          currentTechnicianId: true,
          capabilities: { select: { capability: { select: { code: true } } } },
        },
      }),
      prismaBase.technician.findMany({
        where: { active: true },
        select: {
          id: true,
          capabilities: { select: { capability: { select: { code: true } } } },
        },
      }),
    ]);

    const technicianCodes = new Map(
      technicians.map((technician) => [
        technician.id,
        new Set(technician.capabilities.map((link) => link.capability.code)),
      ]),
    );
    const crewedUnits = units.filter(
      (unit) => unit.currentTechnicianId !== null && technicianCodes.has(unit.currentTechnicianId),
    );

    const rows = capabilities.map((capability) => {
      const code = capability.code;
      const unitHas = (unit: (typeof units)[number]): boolean =>
        unit.capabilities.some((link) => link.capability.code === code);

      // THE OPERATIVE NUMBER is crews where BOTH halves hold it: a capability
      // on a van whose driver is not certified in it cannot be dispatched.
      const pairs = crewedUnits.filter(
        (unit) => unitHas(unit) && technicianCodes.get(unit.currentTechnicianId ?? '')?.has(code),
      );

      return summarise({
        code,
        crewedPairs: pairs.length,
        unitsWithCapability: units.filter(unitHas).length,
        techniciansWithCapability: technicians.filter((technician) =>
          technicianCodes.get(technician.id)?.has(code),
        ).length,
        totalCrewedUnits: crewedUnits.length,
        totalTechnicians: technicians.length,
      });
    });

    res.json({
      capabilities: rows.sort(byUrgency),
      totalCrewedUnits: crewedUnits.length,
      totalTechnicians: technicians.length,
    });
  },
);

// ---------------------------------------------------------------------------
// THE PRIORITY QUEUE. Safety first, lexicographically — src/domain/priority.ts
// carries the argument for why it is not a weighted score.
consoleRouter.get('/queue', authenticate, requirePermission('read', 'job'), async (_req, res) => {
  const now = new Date();

  const jobs = await prismaBase.job.findMany({
    where: { status: { in: ['INTAKE', 'PLANNED'] }, assignedUnitId: null },
    select: {
      id: true,
      safetyLevel: true,
      createdAt: true,
      zoneId: true,
      status: true,
      slaPolicy: { select: { responseMinutes: true } },
    },
  });

  const queued = jobs.map((job) => ({
    id: job.id,
    safetyLevel: job.safetyLevel,
    createdAt: job.createdAt,
    slaResponseMinutes: job.slaPolicy?.responseMinutes ?? null,
    zoneId: job.zoneId,
    status: job.status,
  }));

  // The three sort keys are returned alongside the order, so an operator can
  // see WHY a job sits where it does rather than trusting the sequence.
  res.json({
    jobs: orderQueue(queued, now).map((job) => ({
      id: job.id,
      zoneId: job.zoneId,
      status: job.status,
      safetyLevel: job.safetyLevel,
      slaRisk: Number(slaRisk(job, now).toFixed(3)),
      ageMinutes: Math.round(ageMinutes(job, now)),
      slaResponseMinutes: job.slaResponseMinutes,
    })),
    at: now.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// SELECTING A PLAN. The only write in this file.
//
// IT RECORDS A DECISION; IT DOES NOT DISPATCH. Turning a plan into
// reservations means one saga per assignment, and the path for that is Phase
// 13's action queue — one job at a time, with a dispatcher confirming each. A
// single click starting twenty sagas is not something this phase asks for, and
// not something worth building by implication.
const selectSchema = z
  .object({ overrideReasonCode: z.string().min(3).max(200).optional() })
  .strict();

consoleRouter.post(
  '/plans/:id/select',
  authenticate,
  requirePermission('update', 'planSelection'),
  async (req, res) => {
    const auth = req.auth;
    const id = req.params.id;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = selectSchema.parse(req.body ?? {});

    const result = await selectPlan(prismaBase, {
      planVariantId: id,
      actor: { role: auth.role, id: auth.userId },
      overrideReasonCode: body.overrideReasonCode ?? null,
    });

    if (result.outcome === 'NOT_FOUND') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result.outcome === 'ALREADY_SELECTED') {
      // 409, not an error page: another dispatcher got there first, which is a
      // normal outcome on a shared board. The label tells the caller what was
      // actually chosen so the console can show it rather than guess.
      res.status(409).json({ error: 'already_selected', label: result.label });
      return;
    }
    if (result.outcome === 'OVERRIDE_REASON_REQUIRED') {
      // 422 rather than 400: the request was well-formed, and what is missing
      // is a justification rather than a field.
      res.status(422).json({
        error: 'override_reason_required',
        label: result.label,
        recommended: result.recommended,
      });
      return;
    }

    res.json({
      planVariantId: result.planVariantId,
      label: result.label,
      isOverride: result.isOverride,
      recommended: RECOMMENDED_PLAN,
      decisionsRecorded: result.decisionRecordIds.length,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /degraded/payments — WHICH authorisations are stuck, not just how many.
//
// The health banner has said "3 authorisations waiting on the provider" since
// Phase 17 (src/health/probes.ts's probePayments) and there was nowhere to go
// from it. Invariant 8 asks that every degraded state be visible to an
// operator, and a number with no list is a state an operator can see and not
// act on: they cannot ring the customer, cannot tell a technician the callout
// is unpaid, cannot tell whether it is one provider outage or three unrelated
// cards.
//
// THE SAME THRESHOLD THE PROBE COUNTED WITH, imported rather than repeated, so
// the banner's number and this list are the same set by construction.
//
// READS NOTHING SENSITIVE. A payment row carries an amount, a status and a
// gateway order reference — never a card number; the card is typed into
// Razorpay's own iframe and never reaches this database at all (see
// src/api/checkout.ts).
consoleRouter.get(
  '/degraded/payments',
  authenticate,
  // `paymentBacklog`, never `payment`: a DRIVER holds full `payment`
  // permission for their own checkout, and this list is the whole fleet's.
  requirePermission('read', 'paymentBacklog'),
  async (_req, res) => {
    const stuckSince = new Date(Date.now() - PAYMENT_PENDING_AFTER_MS);

    const payments = await prismaBase.payment.findMany({
      where: { status: 'PENDING_AUTHORISATION', createdAt: { lt: stuckSince } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        jobId: true,
        amountPaise: true,
        createdAt: true,
        gatewayOrderRef: true,
        job: { select: { status: true, zoneId: true } },
      },
    });

    res.json({
      payments: payments.map((payment) => ({
        paymentId: payment.id,
        jobId: payment.jobId,
        jobStatus: payment.job.status,
        zoneId: payment.job.zoneId,
        amount: formatRupees(payment.amountPaise),
        // How long it has been stuck, which is the figure that says whether
        // this is a slow round trip or a provider that has stopped answering.
        waitingMinutes: Math.floor((Date.now() - payment.createdAt.getTime()) / 60_000),
        orderRef: payment.gatewayOrderRef,
      })),
    });
  },
);
