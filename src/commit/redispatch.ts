// RE-DISPATCH — what happens when a trigger fires.
//
// The shape is always the same, whatever fired it:
//   1. Is this job thrashing? If so escalate to a human and stop.
//   2. Does this trigger even cause a re-solve? (A cancellation does not.)
//   3. Re-solve the job.
//   4. Is the answer the same as what we already have? Then do nothing —
//      a re-solve producing the same assignment is a NO-OP, not a churn event.
//   5. Otherwise raise a RECOMMEND action carrying the impact, for a
//      dispatcher to take. Executing it starts Phase 12's saga.
//
// STEP 4 IS THE ONE PEOPLE MISS. Without it every trigger looks like churn in
// the metrics, and a system that re-solves ten times and changes nothing is
// indistinguishable from one that reassigned ten times. The two are wildly
// different operationally and the difference has to be visible.
//
// THRASH CONTROL sits at step 1 rather than step 5 deliberately: a job that
// has already been reassigned three times should not consume another solve at
// all. The cost being defended against is not the reassignment, it is the
// oscillation.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { config } from '../infra/config.js';
import {
  causesResolve,
  shouldEscalateForThrash,
  terminatesJob,
} from '../domain/replanTriggers.js';
import type { ReplanTrigger } from '../domain/replanTriggers.js';
import { requestAction, hasOpenAction } from './actionRequests.js';
import { buildDispatchSnapshot } from './dispatchSnapshot.js';
import { persistSolverRun } from './persistSolverRun.js';
import { solve } from '../engine/solve.js';
import { startSaga } from './saga.js';
import { appendJobEvent } from '../intake/events.js';

export type RedispatchOutcome =
  | { outcome: 'ESCALATED'; actionRequestId: string; reason: string }
  | { outcome: 'NO_CHANGE'; solverRunId: string | null; reason: string }
  | { outcome: 'REASSIGNMENT_PROPOSED'; actionRequestId: string; unitId: string; technicianId: string }
  | { outcome: 'NO_OPTION'; solverRunId: string | null };

export type HandleTriggerInput = {
  jobId: string;
  trigger: ReplanTrigger;
  detail?: string;
  actor?: { role: string; id: string | null };
};

// How many times this job has already been reassigned. Counted from the
// durable record rather than held in memory, because thrash is a property of
// the job's history and has to survive a restart.
async function reassignmentCount(db: PrismaClient, jobId: string): Promise<number> {
  return db.dispatchOffer.count({ where: { jobId } });
}

export async function handleTrigger(
  db: PrismaClient,
  input: HandleTriggerInput,
): Promise<RedispatchOutcome> {
  const { jobId, trigger } = input;

  // 1. THRASH CONTROL.
  const reassignments = await reassignmentCount(db, jobId);
  if (shouldEscalateForThrash(reassignments) && !terminatesJob(trigger)) {
    if (await hasOpenAction(db, { jobId, kind: 'ESCALATE_THRASHING_JOB' })) {
      return { outcome: 'NO_CHANGE', solverRunId: null, reason: 'already escalated for thrash' };
    }
    const action = await requestAction(db, {
      jobId,
      kind: 'ESCALATE_THRASHING_JOB',
      reason: `reassigned ${reassignments} times; latest trigger ${trigger}`,
      impact: { reassignments, trigger },
      actor: input.actor,
    });
    return {
      outcome: 'ESCALATED',
      actionRequestId: action.actionRequestId,
      reason: `reassigned ${reassignments} times`,
    };
  }

  // 2. A cancellation ends the job rather than re-planning it. The branch is
  // kept general rather than written as `if (trigger === 'JOB_CANCELLED')`,
  // because whether a trigger re-solves is a property of the trigger and
  // belongs in the list that defines them.
  if (!causesResolve(trigger)) {
    return { outcome: 'NO_CHANGE', solverRunId: null, reason: `${trigger} does not re-solve` };
  }

  // 3. RE-SOLVE, for this job only. A whole-zone solve is what the debounced
  // queue job does; a trigger about one job asks about one job.
  // `includeAssigned` because a re-dispatch is about a job that already HAS a
  // crew — the default snapshot filters exactly those out.
  const { jobs, snapshot, jobZone } = await buildDispatchSnapshot(db, {
    jobIds: [jobId],
    includeAssigned: true,
  });
  if (jobs.length === 0) {
    return { outcome: 'NO_CHANGE', solverRunId: null, reason: 'job is not in a dispatchable state' };
  }

  const outcome = await solve({
    jobs,
    snapshot,
    now: new Date(),
    jobZone,
    zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
  });
  const solverRunId = await persistSolverRun(db, { outcome, trigger, jobId });

  const plan = outcome.plans.find((candidate) => candidate.label === 'BALANCED');
  const assignment = plan?.assignments.find((candidate) => candidate.jobId === jobId);
  if (!assignment) {
    return { outcome: 'NO_OPTION', solverRunId };
  }

  // 4. THE SAME ANSWER IS NOT A CHANGE.
  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { assignedUnitId: true, assignedTechnicianId: true },
  });
  if (
    job.assignedUnitId === assignment.unitId &&
    job.assignedTechnicianId === assignment.technicianId
  ) {
    logger.info({ jobId, trigger, solverRunId }, 're-solve produced the same assignment; no-op');
    return { outcome: 'NO_CHANGE', solverRunId, reason: 'same assignment' };
  }

  // 5. A real change. RECOMMEND, with the impact a dispatcher needs to judge
  // it — not AUTO, because this changes who is driving to a breakdown.
  const action = await requestAction(db, {
    jobId,
    kind:
      trigger === 'DIAGNOSIS_CHANGED'
        ? 'REASSIGN_AFTER_DIAGNOSIS_CHANGE'
        : 'REASSIGN_AFTER_TRIGGER',
    reason: input.detail ?? `re-solve after ${trigger}`,
    impact: {
      trigger,
      solverRunId,
      from: { unitId: job.assignedUnitId, technicianId: job.assignedTechnicianId },
      to: { unitId: assignment.unitId, technicianId: assignment.technicianId },
      expectedResolutionMinutes: assignment.cost.expectedTimeToResolution.value,
      totalCost: assignment.cost.total,
      // DOES THE CREW ALREADY ON SITE SURVIVE THE NEW PLAN? Computed here,
      // where both halves are in hand, and carried on the action so the
      // dispatcher sees it before deciding and `executeReassignment` does not
      // have to work it out again from stale rows.
      technicianRetained: job.assignedTechnicianId === assignment.technicianId,
      releasedTechnicianId:
        job.assignedTechnicianId && job.assignedTechnicianId !== assignment.technicianId
          ? job.assignedTechnicianId
          : null,
    },
    actor: input.actor,
  });

  return {
    outcome: 'REASSIGNMENT_PROPOSED',
    actionRequestId: action.actionRequestId,
    unitId: assignment.unitId,
    technicianId: assignment.technicianId,
  };
}

// ---------------------------------------------------------------------------
// EXECUTING an approved reassignment — where a plan finally becomes a
// reservation, and where the technician standing at the roadside finds out
// whether they are still on this job.
//
// THE TECHNICIAN EITHER WAITS OR IS EXPLICITLY RELEASED. Those are the only
// two outcomes, and the difference is whether the new plan still uses them:
//   - retained → nothing happens to them. They are already on site and the
//     new plan wants them there, so the correct action is no action.
//   - not retained → the old assignment is torn down FIRST: the job is
//     detached from them, their van returns to AVAILABLE, and a JobEvent says
//     so. Never left holding a job the system has quietly moved on from.
//
// RELEASE HAPPENS ON EXECUTE, NOT ON PROPOSE. While the RECOMMEND is sitting
// in a dispatcher's queue the old crew is still the assignment — releasing
// them when the action was merely raised would leave the job with nobody
// while a human decided.
//
// This is also the first caller `startSaga` has had since Phase 12 built it.

export type ExecuteInput = {
  actionRequestId: string;
  actor: { role: string; id: string | null };
};

export type ExecuteOutcome =
  | {
      outcome: 'SAGA_STARTED';
      sagaId: string;
      technicianRetained: boolean;
      releasedTechnicianId: string | null;
    }
  // The saga was born terminal: its first leg lost the version-checked race,
  // so the unit moved on between the RECOMMEND being raised and the
  // dispatcher pressing execute. Reported as its own outcome rather than
  // folded into SAGA_STARTED — "a saga exists" and "a unit is held" are
  // different facts, and a caller told the first while the second is false
  // has been misled.
  | { outcome: 'SAGA_LOST_RACE'; sagaId: string; reason: string }
  | { outcome: 'NOT_EXECUTABLE'; reason: string };

type ReassignImpact = {
  to?: { unitId?: string; technicianId?: string };
  from?: { unitId?: string | null; technicianId?: string | null };
  technicianRetained?: boolean;
  releasedTechnicianId?: string | null;
};

export async function executeReassignment(
  db: PrismaClient,
  input: ExecuteInput,
): Promise<ExecuteOutcome> {
  const action = await db.actionRequest.findUnique({
    where: { id: input.actionRequestId },
    select: { id: true, jobId: true, status: true, kind: true, computedImpact: true },
  });
  if (!action?.jobId) return { outcome: 'NOT_EXECUTABLE', reason: 'action not found' };

  const impact = action.computedImpact as ReassignImpact | null;
  const unitId = impact?.to?.unitId;
  const technicianId = impact?.to?.technicianId;
  if (!unitId || !technicianId) {
    return { outcome: 'NOT_EXECUTABLE', reason: 'action carries no target assignment' };
  }

  const retained = impact?.technicianRetained === true;
  const releasedTechnicianId = impact?.releasedTechnicianId ?? null;

  if (!retained && releasedTechnicianId) {
    await releaseCurrentCrew(db, {
      jobId: action.jobId,
      technicianId: releasedTechnicianId,
      unitId: impact?.from?.unitId ?? null,
      actor: input.actor,
    });
  }

  // Read the unit's version NOW, not when the action was raised. The saga's
  // first leg is version-checked, so a unit that moved while the action sat in
  // a dispatcher's queue loses the race and the saga is born terminal — which
  // is the correct outcome, not an error.
  const unit = await db.unit.findUnique({ where: { id: unitId }, select: { version: true } });
  if (!unit) return { outcome: 'NOT_EXECUTABLE', reason: 'unit no longer exists' };

  const saga = await startSaga(db, {
    jobId: action.jobId,
    unitId,
    technicianId,
    expectedUnitVersion: unit.version,
  });

  if (saga.outcome === 'REQUEUED') {
    return { outcome: 'SAGA_LOST_RACE', sagaId: saga.sagaId, reason: saga.reason };
  }

  return {
    outcome: 'SAGA_STARTED',
    sagaId: saga.sagaId,
    technicianRetained: retained,
    releasedTechnicianId,
  };
}

// Tearing down an assignment the new plan does not want. Conditional on the
// unit still being ON_JOB for this job, so a van that has already moved on is
// not dragged back to AVAILABLE.
async function releaseCurrentCrew(
  db: PrismaClient,
  input: {
    jobId: string;
    technicianId: string;
    unitId: string | null;
    actor: { role: string; id: string | null };
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.job.updateMany({
      where: { id: input.jobId, assignedTechnicianId: input.technicianId },
      data: {
        assignedUnitId: null,
        assignedTechnicianId: null,
        status: 'PLANNED',
        version: { increment: 1 },
      },
    });

    if (input.unitId) {
      await tx.unit.updateMany({
        where: { id: input.unitId, status: 'ON_JOB' },
        data: { status: 'AVAILABLE', version: { increment: 1 } },
      });
    }

    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'TECHNICIAN_RELEASED_FROM_JOB',
      payload: {
        technicianId: input.technicianId,
        unitId: input.unitId,
        reason: 'the re-solve after this trigger does not use this crew',
      },
      actorRole: input.actor.role,
      actorId: input.actor.id,
    });
  });
}
