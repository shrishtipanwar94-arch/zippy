// THE REFERENCE JOB — one earlier job, already finished, so the dispatcher's
// board is not empty before the demo starts.
//
// CREATED THROUGH THE REAL PATH, NOT INSERTED. Every step below is the function
// the matching route calls: intake (createIntakeJob, recordIntakeAnswer), the
// re-plan and the card (handleTrigger), the dispatcher's Execute
// (resolveAction + executeReassignment), the technician's answer
// (recordTechnicianDecision), the ladder (applyTechnicianAction) and the money
// (authoriseCalloutQuietly, captureOnCompletionQuietly). So its candidate table,
// its decision record, its events and its ledger rows are genuine — the
// inspector shows why each crew won or lost, exactly as it would for a live job.
//
// WHY IT ENDS RESOLVED, ON CREW D, AFTER CREW B DECLINED. A job that was still
// in progress would hold its crew's van, and every live demo job would then
// show that crew as "unit is on a job" instead of the reason it was put on the
// board to show: on A or C that spoils the candidate table, and on D it breaks
// the decline-and-requeue act, because D is where a declined job goes. A
// finished job holds nothing. Its history also shows the requeue once:
// offered to B, declined, re-planned without B, taken by D.
//
// ONCE. If the reference driver's car already has a job, nothing is created —
// running the seed on every boot never makes a second one.

import type { PrismaClient } from '@prisma/client';
import { createIntakeJob } from '../../src/intake/createJob.js';
import { recordIntakeAnswer } from '../../src/intake/answers.js';
import { handleTrigger, executeReassignment } from '../../src/commit/redispatch.js';
import type { RedispatchOutcome } from '../../src/commit/redispatch.js';
import { resolveAction } from '../../src/commit/actionRequests.js';
import { recordTechnicianDecision } from '../../src/commit/saga.js';
import { recordArrivalEstimateQuietly } from '../../src/commit/arrivalEstimate.js';
import { authoriseCalloutQuietly, captureOnCompletionQuietly } from '../../src/commit/payments.js';
import { applyTechnicianAction } from '../../src/commit/technicianActions.js';
import { ensureCompletionCode } from '../../src/commit/completionCode.js';
import { safetyReportSchema } from '../../src/domain/safety.js';
import { locationSchema } from '../../src/domain/location.js';
import { LADDER_STEPS } from '../../src/domain/jobLadder.js';
import { DEMO_CREWS, DEMO_REFERENCE_DRIVER } from '../../src/demo/demoCrews.js';
import { FAULT_SCENARIOS } from '../../src/demo/faultScenarios.js';

// A flat tyre at Lodhi Garden: a different fault and a different place from
// the battery the presenter will report, and one intake settles without a
// single follow-up question.
const REFERENCE_FAULT = 'FLAT_TYRE';
const REFERENCE_LOCATION = { lat: 28.5931, lng: 77.2197, landmark: 'Lodhi Garden, gate 1' };
const SYSTEM_ACTOR = { role: 'SYSTEM', id: null };
// Intake is filed by the reference driver themselves, as a real report is.
const DRIVER_ACTOR = { role: 'DRIVER', id: DEMO_REFERENCE_DRIVER.userId };

export type ReferenceJobOutcome = { created: boolean; jobId: string | null; status: string | null };

async function existingReferenceJob(db: PrismaClient): Promise<{ id: string; status: string } | null> {
  return db.job.findFirst({
    where: { vehicle: { registration: DEMO_REFERENCE_DRIVER.registration } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true },
  });
}

async function report(db: PrismaClient, vehicleId: string, tenantId: string | null): Promise<string> {
  const scenario = FAULT_SCENARIOS.find((candidate) => candidate.fault === REFERENCE_FAULT)!;
  const created = await createIntakeJob(db, {
    driverId: DEMO_REFERENCE_DRIVER.driverId,
    vehicleId,
    tenantId,
    symptoms: scenario.answers,
    safety: safetyReportSchema.parse({}),
    location: locationSchema.parse(REFERENCE_LOCATION),
    actor: DRIVER_ACTOR,
    at: new Date(),
  });

  // Answer anything intake still asks with its first offered answer, as the
  // dry check does. A flat tyre normally needs none.
  let next = created.next;
  for (let asked = 0; !next.done && asked < 12; asked++) {
    const answered = await recordIntakeAnswer(db, {
      jobId: created.jobId,
      questionCode: next.question.code,
      answer: next.question.answers[0]!.value,
      actor: DRIVER_ACTOR,
      at: new Date(),
    });
    next = answered.next;
  }
  return created.jobId;
}

// The card the re-plan raised, executed as a dispatcher would. Returns the id
// of the technician offer it produced.
async function execute(db: PrismaClient, jobId: string, planned: RedispatchOutcome): Promise<{ offerId: string; sagaId: string; technicianId: string }> {
  if (planned.outcome !== 'REASSIGNMENT_PROPOSED') {
    throw new Error(`reference job: re-plan gave ${planned.outcome}, not a dispatch card`);
  }
  await resolveAction(db, { actionRequestId: planned.actionRequestId, decision: 'EXECUTED', approver: SYSTEM_ACTOR });
  const saga = await executeReassignment(db, { actionRequestId: planned.actionRequestId, actor: SYSTEM_ACTOR });
  if (saga.outcome !== 'SAGA_STARTED') throw new Error(`reference job: execute gave ${saga.outcome}`);

  const offer = await db.technicianOffer.findFirstOrThrow({
    where: { jobId, status: 'PROPOSED' },
    orderBy: { sentAt: 'desc' },
    select: { id: true, dispatchOfferId: true, technicianId: true },
  });
  return { offerId: offer.id, sagaId: offer.dispatchOfferId!, technicianId: offer.technicianId };
}

async function workTheLadder(db: PrismaClient, jobId: string, technicianId: string): Promise<void> {
  const completionCode = await db.$transaction((tx) => ensureCompletionCode(tx, jobId));
  let sequence = 0;
  for (const step of LADDER_STEPS) {
    sequence += 1;
    const result = await applyTechnicianAction(db, {
      jobId,
      technicianId,
      idempotencyKey: `demo-reference-${step}`,
      step,
      clientSequence: sequence,
      eventTime: new Date(),
      completionCode: step === 'COMPLETE' ? completionCode : undefined,
    });
    if (result.outcome !== 'APPLIED' && result.outcome !== 'REPLAYED') {
      throw new Error(`reference job: ${step} gave ${result.outcome}`);
    }
  }
  await captureOnCompletionQuietly(db, jobId);
}

export async function ensureReferenceJob(db: PrismaClient): Promise<ReferenceJobOutcome> {
  const existing = await existingReferenceJob(db);
  if (existing) return { created: false, jobId: existing.id, status: existing.status };

  const vehicle = await db.vehicle.findUniqueOrThrow({
    where: { registration: DEMO_REFERENCE_DRIVER.registration },
    select: { id: true, tenantId: true },
  });
  const jobId = await report(db, vehicle.id, vehicle.tenantId);

  let offer = await execute(db, jobId, await handleTrigger(db, { jobId, trigger: 'INTAKE_COMPLETED' }));

  // Crew B declines, as it would on a day it was already busy; the re-plan
  // leaves B out and the job goes to the next-best crew.
  const crewB = DEMO_CREWS.find((crew) => crew.label === 'B')!;
  if (offer.technicianId === crewB.technicianId) {
    await recordTechnicianDecision(db, { sagaId: offer.sagaId, decision: 'DECLINED' });
    const replanned = await handleTrigger(db, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      detail: 'offer declined: re-planned without the crew that refused',
      excludeTechnicianIds: [crewB.technicianId],
    });
    offer = await execute(db, jobId, replanned);
  }

  const state = await recordTechnicianDecision(db, { sagaId: offer.sagaId, decision: 'ACCEPTED' });
  if (state !== 'COMMITTED') throw new Error(`reference job: accept gave ${state}`);
  await recordArrivalEstimateQuietly(db, jobId);
  await authoriseCalloutQuietly(db, jobId);

  await workTheLadder(db, jobId, offer.technicianId);

  const finished = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } });
  return { created: true, jobId, status: finished.status };
}
