// SLA ESCALATION — written, tested by nobody, and deliberately not wired.
//
// STATUS: Phase 13 Stage 2. This module exists and compiles; nothing calls it.
// The detection is not the hard part — the RESPONSE is. Raising an APPROVE
// action blocks pending sign-off, which means a job that is ALREADY late then
// waits longer in an approval queue. Whether the right shape is a blocking
// APPROVE, or an AUTO relaxation that dispatches immediately plus a RECOMMEND
// for the commercial follow-up, is an open decision recorded in DECISIONS.log.
// Running this now would raise those actions for real while the question is
// still open, so the cleanup worker does not call it yet.
//
// It lives in /src/commit rather than /src/workers because it WRITES —
// ActionRequest rows and a JobEvent — and mutation belongs here regardless of
// which scheduler eventually invokes it.

import type { Prisma } from '@prisma/client';
import { tierFor } from '../domain/actionTiers.js';

// A JOB WHOSE SLA WINDOW CLOSED WHILE IT WAS STILL QUEUED — the trigger whose
// cause is the clock rather than an event, and the reason it needs a sweep
// rather than a hook.
//
// Phase 10's harness measured what happens without this: `SLA_UNREACHABLE` is
// a hard filter evaluated against `now`, so the moment a job passes its
// promised window EVERY option for it is rejected and it can never be
// dispatched again. It stops appearing in plans and nothing says so — the one
// trace is a dispatch_options row whose rejection code reads exactly like the
// ordinary, healthy case of a single unit being too far away. A stranded
// customer, invisible. Invariant 8 exists to forbid precisely that.
//
// Re-solving would not help: it returns what it returned a minute ago, which
// is nothing. So this raises an APPROVE-tier action instead, and a human makes
// the call the engine has no standing to make — serve it late, re-contract the
// window, escalate to a partner, or cancel with the customer told.
//
// ONE ACTION PER JOB, not one every five minutes: an operator queue that
// refills itself is one nobody reads.
export async function escalateClosedSlaWindows(tx: Prisma.TransactionClient): Promise<number> {
  const now = new Date();

  const stranded = await tx.job.findMany({
    where: {
      status: { in: ['INTAKE', 'PLANNED'] },
      assignedUnitId: null,
      slaPolicy: { is: { responseMinutes: { not: undefined } } },
    },
    select: {
      id: true,
      createdAt: true,
      slaPolicy: { select: { responseMinutes: true } },
      actionRequests: {
        where: { kind: 'ESCALATE_SLA_WINDOW_CLOSED', status: 'PENDING' },
        select: { id: true },
      },
    },
  });

  let raised = 0;
  for (const job of stranded) {
    const minutes = job.slaPolicy?.responseMinutes;
    if (minutes === undefined || minutes === null) continue;
    if (job.actionRequests.length > 0) continue;

    const deadline = new Date(job.createdAt.getTime() + minutes * 60_000);
    if (deadline > now) continue;

    const overdueMinutes = Math.round((now.getTime() - deadline.getTime()) / 60_000);

    // Written directly rather than through requestAction() because this runs
    // inside the sweep's transaction, and requestAction opens its own.
    const action = await tx.actionRequest.create({
      data: {
        jobId: job.id,
        tier: tierFor('ESCALATE_SLA_WINDOW_CLOSED'),
        kind: 'ESCALATE_SLA_WINDOW_CLOSED',
        reason: `SLA window of ${minutes}min closed ${overdueMinutes}min ago while the job was still unassigned; every option is now filtered by the deadline rather than by capacity`,
        computedImpact: { slaResponseMinutes: minutes, overdueMinutes },
        status: 'PENDING',
        requestedByRole: 'SYSTEM',
      },
      select: { id: true },
    });

    const last = await tx.jobEvent.findFirst({
      where: { jobId: job.id },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    await tx.jobEvent.create({
      data: {
        jobId: job.id,
        sequence: (last?.sequence ?? 0) + 1,
        eventType: 'SLA_WINDOW_CLOSED_WHILE_QUEUED',
        payload: { actionRequestId: action.id, overdueMinutes },
        actorRole: 'SYSTEM',
      },
    });
    raised += 1;
  }

  return raised;
}
