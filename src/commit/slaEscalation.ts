// SLA BREACH ESCALATION — the commercial follow-up, not a gate on dispatch.
//
// Phase 10 measured the problem: `SLA_UNREACHABLE` was evaluated against
// `now`, so a job still queued when its window closed had every option
// rejected forever and silently stopped appearing in any plan.
//
// PHASE 13 STAGE 3 FIXED THE DISPATCH HALF IN THE FILTER, not here:
// feasibility now stops filtering on a deadline once it has passed, so a late
// job competes for a van normally. This sweep exists for what is left over —
// the fact that a promise was broken, which is a commercial matter with a
// human owner.
//
// RECOMMEND, NOT APPROVE. An APPROVE action blocks pending sign-off, and
// tiering a late job that way would make it wait longer still, for a human to
// acknowledge that it is late. Nothing about the van is gated on this.
//
// It lives in /src/commit rather than /src/workers because it WRITES —
// ActionRequest rows and a JobEvent — and mutation belongs here regardless of
// which scheduler invokes it.

import type { Prisma } from '@prisma/client';
import { tierFor } from '../domain/actionTiers.js';

// A sweep rather than a hook, because the cause is the clock rather than an
// event: nothing happens at the moment a deadline passes, so something has to
// go and look. Invariant 8 — a degraded state has to be visible to an
// operator — is what this satisfies.
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
        reason: `SLA window of ${minutes}min closed ${overdueMinutes}min ago while the job was still unassigned. Dispatch is not blocked — the job is competing for a van normally — this is the commercial follow-up.`,
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
