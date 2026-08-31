// WHAT THE DISPATCHER CHOSE, AND WHY IT DIFFERED FROM THE RECOMMENDATION.
//
// `decision_records` has existed since Phase 1 with no writer. Phase 14 Stage 1
// noted the consequence: the "why this technician?" screen could explain what
// the SOLVER decided and had no way to explain what a HUMAN did with it. This
// is that writer.
//
// THE OVERRIDE REASON IS THE POINT OF THE TABLE. The solver produces three
// plans and recommends one; a dispatcher may take a different one because they
// know something the snapshot does not — a road closed ten minutes ago, a
// technician who is quick with this make of car, a customer who has already
// waited twice. All of that is legitimate and none of it is in the model. What
// is NOT acceptable is that it vanishes: six weeks later "why did we send the
// slower van?" has to be answerable, and the only place that answer can live is
// a row written at the moment of the choice.
//
// So taking the recommended plan needs no reason, and taking any other one
// does. That asymmetry is the whole design: it makes the common case
// frictionless and the exceptional case explain itself.

import type { Prisma, PrismaClient } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';

// The plan the solver puts forward when nobody says otherwise. Fixed here
// rather than chosen per run, and it matches the vector the Phase 10 harness
// measures — so "the recommendation" means the same thing to the evaluation
// and to the console.
export const RECOMMENDED_PLAN = 'BALANCED';

export type SelectPlanInput = {
  planVariantId: string;
  actor: { role: string; id: string | null };
  // Required when the chosen plan is not the recommended one. A free-text code
  // rather than an enum: the useful reasons are not knowable in advance, and a
  // fixed list would push every real reason into OTHER.
  overrideReasonCode?: string | null;
};

export type SelectPlanOutcome =
  | { outcome: 'RECORDED'; planVariantId: string; label: string; decisionRecordIds: string[]; isOverride: boolean }
  | { outcome: 'OVERRIDE_REASON_REQUIRED'; label: string; recommended: string }
  | { outcome: 'NOT_FOUND' };

export async function selectPlan(
  db: PrismaClient,
  input: SelectPlanInput,
): Promise<SelectPlanOutcome> {
  const plan = await db.planVariant.findUnique({
    where: { id: input.planVariantId },
    select: {
      id: true,
      label: true,
      assignments: true,
      solverRunId: true,
      solverRun: { select: { id: true } },
    },
  });
  if (!plan) return { outcome: 'NOT_FOUND' };

  const isOverride = plan.label !== RECOMMENDED_PLAN;
  const reason = input.overrideReasonCode?.trim();

  // Refused BEFORE anything is written. A half-recorded override is worse than
  // a refused one: the assignments would be on the record with no explanation,
  // which is exactly the state this table exists to prevent.
  if (isOverride && !reason) {
    return { outcome: 'OVERRIDE_REASON_REQUIRED', label: plan.label, recommended: RECOMMENDED_PLAN };
  }

  const assignments = Array.isArray(plan.assignments)
    ? (plan.assignments as { jobId: string; unitId: string; technicianId: string; totalCost: number }[])
    : [];

  // Every option the same run considered, so each record can carry the
  // alternatives that were NOT chosen — the half of "why this technician?"
  // that a dispatcher actually asks about.
  const options = await db.dispatchOption.findMany({
    where: { solverRunId: plan.solverRunId },
    select: {
      id: true,
      jobId: true,
      unitId: true,
      technicianId: true,
      feasible: true,
      rejectionCode: true,
      rejectionDetail: true,
      costBreakdown: true,
      coveredFaultProbability: true,
    },
  });

  const optionsByJob = new Map<string, typeof options>();
  for (const option of options) {
    const list = optionsByJob.get(option.jobId) ?? [];
    list.push(option);
    optionsByJob.set(option.jobId, list);
  }

  const decisionRecordIds: string[] = [];

  // One transaction for the whole plan. A plan half-recorded would leave some
  // jobs explained and others not, from a single click.
  await db.$transaction(async (tx) => {
    for (const assignment of assignments) {
      const forJob = optionsByJob.get(assignment.jobId) ?? [];
      const selected = forJob.find(
        (option) => option.feasible && option.unitId === assignment.unitId,
      );

      const record = await tx.decisionRecord.create({
        data: {
          jobId: assignment.jobId,
          solverRunId: plan.solverRunId,
          selectedOptionId: selected?.id ?? null,
          selectedByRole: input.actor.role,
          selectedById: input.actor.id,
          overrideReasonCode: isOverride ? reason : null,
          costBreakdown: (selected?.costBreakdown ?? {}) as Prisma.InputJsonValue,
          coveredFaultProbability: selected?.coveredFaultProbability ?? null,
          rejectedAlternatives: forJob
            .filter((option) => !option.feasible)
            .map((option) => ({
              unitId: option.unitId,
              technicianId: option.technicianId,
              rejectionCode: option.rejectionCode,
              rejectionDetail: option.rejectionDetail,
            })) satisfies Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      decisionRecordIds.push(record.id);

      await appendJobEvent(tx, {
        jobId: assignment.jobId,
        eventType: isOverride ? 'PLAN_OVERRIDDEN' : 'PLAN_SELECTED',
        payload: {
          planVariantId: plan.id,
          label: plan.label,
          unitId: assignment.unitId,
          technicianId: assignment.technicianId,
          overrideReasonCode: isOverride ? reason : null,
        },
        actorRole: input.actor.role,
        actorId: input.actor.id,
      });
    }
  });

  return {
    outcome: 'RECORDED',
    planVariantId: plan.id,
    label: plan.label,
    decisionRecordIds,
    isOverride,
  };
}

// The decision that produced a job's CURRENT assignment, rather than whatever
// solve happened most recently. Phase 13's re-dispatch triggers mean a job can
// be touched by many solves without any of them changing who is going, so
// "newest run" and "the run that decided this" are genuinely different
// questions — and the inspector was answering the wrong one.
export async function latestDecisionFor(
  db: PrismaClient,
  jobId: string,
): Promise<{ solverRunId: string | null; decisionRecordId: string | null; overrideReasonCode: string | null }> {
  const record = await db.decisionRecord.findFirst({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, solverRunId: true, overrideReasonCode: true },
  });

  return {
    solverRunId: record?.solverRunId ?? null,
    decisionRecordId: record?.id ?? null,
    overrideReasonCode: record?.overrideReasonCode ?? null,
  };
}
