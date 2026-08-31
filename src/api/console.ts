// THE DISPATCH CONSOLE'S TWO READ ENDPOINTS.
//
// Both are pure reads over data earlier phases already wrote. Nothing here
// computes a decision, re-scores an option or re-runs a solve — the console's
// whole value is that it renders what the engine already recorded, so what a
// dispatcher sees is what actually happened rather than a second opinion
// generated at render time.
//
// GET /events    the incident timeline: job_events, filterable
// GET /jobs/:id/decision   "why this technician?": the last solve for one job

import { Router } from 'express';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';

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
// THE DecisionRecord TABLE IS EMPTY, and this endpoint deliberately does not
// pretend otherwise. `decision_records` has existed since Phase 1 and nothing
// has ever written a row: the natural writer is the moment a saga commits an
// assignment (Phase 12), which records the option chosen, who chose it, and
// any override reason. That is a write, and this stage is a read.
//
// What DOES exist is everything the record would hold, one level down:
// `dispatch_options` carries every option the solver generated for a job —
// each rejected one with its feasibility reason code, each chosen one with
// its full cost breakdown — keyed to the `solver_run` that produced them. So
// the inspector reads the last solve for a job and renders that.
//
// The distinction matters for one reason a dispatcher would notice: without a
// DecisionRecord there is no record of a HUMAN overriding the solver, because
// nothing captures that a person chose differently from the plan. The screen
// shows what the solver decided and why, not what the operator did with it.
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

    // The most recent solve that considered this job. A job can appear in many
    // runs — every zone re-plan touches it — and the newest is the one whose
    // reasoning still applies.
    const option = await prismaBase.dispatchOption.findFirst({
      where: { jobId: id },
      orderBy: { solverRun: { createdAt: 'desc' } },
      select: { solverRunId: true },
    });

    if (!option) {
      res.json({ job, solverRun: null, chosen: [], rejected: [], hypothesis: job.faultHypotheses[0] ?? null });
      return;
    }

    const [solverRun, options] = await Promise.all([
      prismaBase.solverRun.findUnique({
        where: { id: option.solverRunId },
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
        where: { solverRunId: option.solverRunId, jobId: id },
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
      // Stated in the response rather than only in a comment, so a caller
      // cannot mistake this for a record of what a human decided.
      decisionRecord: null,
      decisionRecordNote:
        'decision_records has no writer yet; this is the solver run, not a record of an operator override',
    });
  },
);
