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

import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { config } from '../infra/config.js';
import {
  causesResolve,
  shouldEscalateForThrash,
  terminatesJob,
} from '../domain/replanTriggers.js';
import type { ReplanTrigger } from '../domain/replanTriggers.js';
import { requestAction, hasOpenAction } from './actionRequests.js';
import { buildEscalationCard, describeRejectionCounts } from '../domain/escalationCard.js';
import type { RejectionCode } from '../engine/feasibility.js';
import { buildDispatchSnapshot } from './dispatchSnapshot.js';
import { persistSolverRun } from './persistSolverRun.js';
import { solve } from '../engine/solve.js';
import { startSaga } from './saga.js';
import { appendJobEvent } from '../intake/events.js';
import { notifyDriverOfReplan, notifyFleetManagerOfStateChange } from '../workers/notification.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export type RedispatchOutcome =
  | { outcome: 'ESCALATED'; actionRequestId: string; reason: string }
  | { outcome: 'NO_CHANGE'; solverRunId: string | null; reason: string }
  | { outcome: 'REASSIGNMENT_PROPOSED'; actionRequestId: string; unitId: string; technicianId: string }
  // `escalated` says whether this run RAISED the card or found one already
  // open. A caller that logs "escalated" on every repeat would report a fleet
  // in crisis when one job has been unplannable for an hour.
  | {
      outcome: 'NO_OPTION';
      solverRunId: string | null;
      escalated?: boolean;
      actionRequestId?: string;
    };

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

  // Read once, used twice: to pick the objective below, and to decide whether
  // the answer actually changed.
  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { assignedUnitId: true, assignedTechnicianId: true, safetyLevel: true },
  });

  // THE OBJECTIVE FLIPS WHEN SAFETY DOES — Phase 15b.
  //
  // Every re-solve until now took the BALANCED plan. For a HIGH_RISK job that
  // is the wrong trade: somebody is standing next to moving traffic, and the
  // question stops being "who resolves this soonest and cheapest" and becomes
  // "who gets there soonest". Invariant 4 already puts safety ABOVE cost when
  // ranking options; this puts it above the choice of which cost function to
  // rank with, which is the same argument applied one level up.
  //
  // FASTEST_RESOLUTION is not literally minimise-arrival — it weights expected
  // time to RESOLUTION, which includes diagnosis and repair. It is the vector
  // this codebase has that comes closest, and adding a fourth would change the
  // plan count the console's competing-plans panel is built around. Recorded
  // as a weakness rather than papered over.
  const objective = job.safetyLevel === 'HIGH_RISK' ? 'FASTEST_RESOLUTION' : 'BALANCED';
  const plan = outcome.plans.find((candidate) => candidate.label === objective);
  const assignment = plan?.assignments.find((candidate) => candidate.jobId === jobId);
  if (!assignment) {
    return escalateNoFeasiblePlan(db, { jobId, trigger, solverRunId, outcome, actor: input.actor });
  }

  // 4. THE SAME ANSWER IS NOT A CHANGE.
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
      // THE THIRD LEG'S TARGET, if this job is a tow and candidate generation
      // found somewhere to send it. Null for every ordinary job, and also null
      // for a tow where destination screening came back empty — feasibility
      // already rejected that option, so `assignment` could never be one.
      destinationWorkshopId:
        assignment.option.destination.status === 'CHOSEN'
          ? assignment.option.destination.workshopId
          : null,
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

// NOBODY CAN DO THIS JOB, AND SOMEBODY HAS TO BE TOLD.
//
// This branch used to be `return { outcome: 'NO_OPTION', solverRunId }` and
// nothing else: no action, no job event, not even a log line. The solver had
// correctly established that every van was off shift and the finding went
// nowhere — the queue looked normal, the timeline ended at the trigger, and
// the only way to learn any of it was to open the job and read the escalation
// card, which nothing invited anybody to do. That is invariant 8 failing on
// the one path where the system has the most to say.
//
// TWO WRITES, AND THEY ARE DIFFERENT THINGS.
//   NO_FEASIBLE_PLAN is a FACT about the job, with the breakdown, so the
//     timeline can be filtered by it — "show me every job we could not plan"
//     is a question ACTION_RECOMMEND cannot answer without reading payloads.
//   the ActionRequest is a REQUEST addressed to a person, and it is what puts
//     the job on the worklist a dispatcher actually lives in.
//
// The card itself already exists and is already good (Phase 17,
// src/domain/escalationCard.ts): reason, feasibility code, the closest option
// and why it was refused, the alternative, a recommendation, three actions.
// Nothing here duplicates it — the reason string carries the counts so the row
// is readable at a glance, and the impact carries the card's own summary so
// the operator can decide whether to open it.
//
// ONE CARD PER JOB. A job whose triggers keep firing must not stack twenty
// identical rows; the same `hasOpenAction` guard the thrash branch uses.
async function escalateNoFeasiblePlan(
  db: PrismaClient,
  input: {
    jobId: string;
    trigger: ReplanTrigger;
    solverRunId: string;
    outcome: Awaited<ReturnType<typeof solve>>;
    actor?: { role: string; id: string | null };
  },
): Promise<RedispatchOutcome> {
  const { jobId, trigger, solverRunId, outcome } = input;

  const rejections = outcome.rejected.filter((rejection) => rejection.jobId === jobId);
  const breakdown = describeRejectionCounts(rejections.map((rejection) => rejection.code));
  const card = summariseCard(rejections);

  // Logged whatever happens next. The guard below can skip the writes; it must
  // not skip the record that this run also found nothing, because "it kept
  // finding nothing" is the interesting shape.
  logger.warn(
    { jobId, trigger, solverRunId, optionCount: rejections.length, breakdown },
    're-solve found no feasible option',
  );

  const raised = await raiseNoFeasiblePlan(db, {
    jobId,
    // The breakdown IS the reason. "No feasible plan" on its own is what the
    // operator already knew from the empty board.
    reason: `Re-solve after ${trigger} found no crew: ${breakdown}.`,
    eventPayload: { trigger, solverRunId, optionCount: rejections.length, breakdown },
    // FLAT VALUES RENDER, NESTED ONES DO NOT — panels/actions.js skips object
    // values on purpose, because `computed_impact` is written by four callers
    // with four shapes. So the three things worth reading on the row are flat
    // and the machine-readable counts are nested: recorded for the audit trail,
    // and already said in words in the reason line above.
    impact: {
      trigger,
      solverRunId,
      optionsConsidered: rejections.length,
      reasonCode: card.reasonCode,
      whyNoCrew: card.reason,
      recommendation: card.recommendation,
      rejectionCounts: countByCode(rejections.map((rejection) => rejection.code)),
    },
    actor: input.actor,
  });

  return { outcome: 'NO_OPTION', solverRunId, ...raised };
}

// THE THREE WRITES THAT MAKE A DEAD END VISIBLE, in one place.
//
// Two callers now: a re-solve that found no crew, and a plan that needs a
// workshop nothing can answer. They arrive at the same operational fact — this
// job is not going anywhere and a person has to decide what happens next — so
// they leave the same trail: a `NO_FEASIBLE_PLAN` event the timeline can be
// filtered by, and a RECOMMEND card on the worklist carrying the reason.
//
// ONE CARD PER JOB. A job whose triggers keep firing must not refill a queue
// somebody is trying to read.
async function raiseNoFeasiblePlan(
  db: PrismaClient,
  input: {
    jobId: string;
    reason: string;
    eventPayload: Prisma.InputJsonValue;
    impact: Prisma.InputJsonValue;
    actor?: { role: string; id: string | null };
  },
): Promise<{ escalated: boolean; actionRequestId?: string }> {
  if (await hasOpenAction(db, { jobId: input.jobId, kind: 'ESCALATE_NO_FEASIBLE_PLAN' })) {
    return { escalated: false };
  }

  await appendJobEvent(db, {
    jobId: input.jobId,
    eventType: 'NO_FEASIBLE_PLAN',
    payload: input.eventPayload,
    actorRole: input.actor?.role ?? 'SYSTEM',
    actorId: input.actor?.id ?? null,
  });

  const action = await requestAction(db, {
    jobId: input.jobId,
    kind: 'ESCALATE_NO_FEASIBLE_PLAN',
    reason: input.reason,
    impact: input.impact,
    actor: input.actor,
  });

  return { escalated: true, actionRequestId: action.actionRequestId };
}

function countByCode(codes: RejectionCode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

// The card's headline three fields, from the rejections already in hand. Built
// through `buildEscalationCard` rather than re-derived, so the row and the card
// can never disagree about why this job has no plan.
function summariseCard(
  rejections: { code: RejectionCode; detail: string; option: { unitId: string; technicianId: string; estimatedTravelMinutes: number; missingCapabilities: string[] } }[],
): { reasonCode: string; reason: string; recommendation: string } {
  const card = buildEscalationCard(
    'summary',
    rejections.map((rejection) => ({
      unitId: rejection.option.unitId,
      // The unit CODE and the technician's NAME are joins this path does not
      // have and does not need: nothing in the three fields below reads them.
      // The card the dispatcher opens does the joins (src/api/escalation.ts).
      unitCode: rejection.option.unitId,
      technicianName: null,
      code: rejection.code,
      detail: rejection.detail,
      travelMinutes: rejection.option.estimatedTravelMinutes,
      missingCapabilities: rejection.option.missingCapabilities,
    })),
  );
  return { reasonCode: card.reasonCode, reason: card.reason, recommendation: card.recommendation };
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
  // THE PLAN NEEDS A WORKSHOP TO SAY YES AND NOTHING CAN ASK ONE. Its own
  // outcome rather than a NOT_EXECUTABLE, because the two mean opposite things
  // to whoever is reading: NOT_EXECUTABLE is "this action is malformed or
  // stale", and this is "the action is perfectly well formed and the product
  // cannot honour it". A dispatcher is owed the difference.
  | { outcome: 'DESTINATION_UNCONFIRMABLE'; reason: string; escalated: boolean; actionRequestId?: string }
  | { outcome: 'NOT_EXECUTABLE'; reason: string };

type ReassignImpact = {
  to?: { unitId?: string; technicianId?: string };
  from?: { unitId?: string | null; technicianId?: string | null };
  // The workshop candidate generation chose for this job, if it is a tow —
  // startSaga's third leg. Absent or null for every ordinary job.
  destinationWorkshopId?: string | null;
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

  // FAIL CLOSED ON THE LEG NOBODY CAN ANSWER.
  //
  // startSaga's third leg is a destination offer, and there is no counterparty
  // for it anywhere in this product: no WORKSHOP role, no route that accepts a
  // destination decision, no adapter. `recordDestinationDecision` exists and is
  // called only by tests. So the leg is created, sits at PROPOSED, and is timed
  // out by the offer-expiry worker at the same forty-five second deadline the
  // technician offer uses — at which point `advanceSaga` compensates the whole
  // reservation.
  //
  // WHAT THAT LOOKED LIKE FROM THE ROADSIDE: a technician accepts a tow, and
  // forty-five seconds later is released by a timeout on a leg they could not
  // have influenced, with a notice on their phone saying a re-plan took the job
  // away. It did not. Nothing took it; nothing could ever have completed it.
  //
  // So the reservation is refused BEFORE it starts, and before the current crew
  // is released — a job we cannot dispatch must not also lose the crew it
  // already had. The escalation this raises is the same one a no-crew re-solve
  // raises, because it is the same fact for the operator: this job needs a
  // human now.
  //
  // THIS IS A GUARD, NOT A FIX. It stops the product doing something worse than
  // nothing. Tows stay undispatchable until a workshop is a participant rather
  // than a destination — see INTERVIEW.md §15.44.
  const workshopId = impact?.destinationWorkshopId ?? null;
  if (workshopId) {
    const raised = await raiseNoFeasiblePlan(db, {
      jobId: action.jobId,
      reason:
        'This job needs a tow and the plan names a workshop, but no workshop can be asked ' +
        'to confirm it — there is no workshop counterparty in the system. Dispatching would ' +
        'hold a van, offer the job, and release the technician 45 seconds later on a timeout.',
      eventPayload: { reason: 'DESTINATION_UNCONFIRMABLE', workshopId, actionRequestId: action.id },
      impact: {
        reasonCode: 'NO_DESTINATION_AVAILABLE',
        whyNoCrew: 'The plan requires a workshop to accept the vehicle, and nothing can ask one.',
        recommendation:
          'Arrange the tow destination by phone and record it outside the system, or hand ' +
          'this job to a partner operator.',
        workshopId,
      },
      actor: input.actor,
    });

    logger.warn(
      { jobId: action.jobId, workshopId, actionRequestId: action.id },
      'refused to start a saga whose destination leg cannot be answered',
    );

    return {
      outcome: 'DESTINATION_UNCONFIRMABLE',
      reason: 'no workshop counterparty exists to confirm a destination',
      ...raised,
    };
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
    // BOTH CLOCKS, FROM CONFIG, PASSED EXPLICITLY. They would fall back to the
    // same values if omitted, because the defaults in offers.ts and holds.ts
    // now read the same config — but this is the one call site that turns a
    // plan into a reservation, and the two TTLs that govern it are worth
    // reading at it rather than inferring two modules away. config.ts refuses
    // startup unless the hold outlives the offer by a margin.
    offerTtlMs: config.OFFER_TTL_MS,
    holdTtlMs: config.HOLD_TTL_MS,
    // Always null by the time we get here — the guard above returned for every
    // plan that named one. Passed explicitly rather than dropped so the call
    // still reads as "this saga has no third leg" rather than silently omitting
    // an argument the function accepts.
    workshopId: null,
  });

  if (saga.outcome === 'REQUEUED') {
    return { outcome: 'SAGA_LOST_RACE', sagaId: saga.sagaId, reason: saga.reason };
  }

  // ONE MESSAGE PER RE-PLAN, and this is the moment a re-plan becomes real.
  // Not when the RECOMMEND was raised — a recommendation a dispatcher never
  // takes changes nothing, and telling a driver about it would be telling them
  // about a thought. Debounced on the job for ninety seconds, so the burst this
  // is about to produce (release, requeue, hold, offer, accept, commit, ETA)
  // collapses into one message describing where the job ended up. See
  // workers/notification.ts.
  await notifyDriverOfReplan(action.jobId, `reassignment:${action.kind}`).catch((error) => {
    // A driver missing an update is not a reason to fail a reservation that
    // has already started.
    logger.warn({ err: error, jobId: action.jobId }, 'could not enqueue a replan notification');
  });
  // AND, ON ITS OWN SLOWER CADENCE (Phase 21), THE FLEET MANAGER. The delivery
  // side skips a walk-in job silently — see workers/notification.ts — so this
  // call site does not need to know or check whether one exists.
  await notifyFleetManagerOfStateChange(action.jobId, `reassignment:${action.kind}`).catch((error) => {
    logger.warn({ err: error, jobId: action.jobId }, 'could not enqueue a fleet notification');
  });

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
  await runPublishingTransaction(db, async (tx) => {
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
