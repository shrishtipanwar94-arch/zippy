// ACTION REQUESTS — every decision the system makes, as a row.
//
// The alternative this replaces is scattered if-statements: one place that
// silently notifies, another that silently reassigns, a third that logs a
// warning nobody reads. A row per action means an operator can answer "what
// did the system do, and why?" from a table rather than from logs, and it
// means the tier — may this happen alone? — is decided by a lookup rather than
// by whichever branch happened to run.
//
// WHAT EACH ROW CARRIES: the tier, the kind, a reason written for a human, the
// computed impact (what changes if this executes), and a resolution once it is
// done. `computed_impact` is the field that makes RECOMMEND worth anything —
// a dispatcher asked to approve a reassignment needs to see what it costs, not
// just that the system would like to do it.

import type { ActionStatus, Prisma, PrismaClient } from '@prisma/client';
import { tierFor, executesImmediately } from '../domain/actionTiers.js';
import type { ActionKind } from '../domain/actionTiers.js';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export type RequestActionInput = {
  jobId: string;
  kind: ActionKind;
  reason: string;
  impact?: Prisma.InputJsonValue;
  actor?: { role: string; id: string | null };
};

export type ActionOutcome = {
  actionRequestId: string;
  tier: ReturnType<typeof tierFor>;
  status: ActionStatus;
  // True when the caller should go ahead and do the thing now. Only AUTO
  // actions come back executable; everything else is waiting on a person.
  executeNow: boolean;
};

export async function requestAction(
  db: PrismaClient,
  input: RequestActionInput,
): Promise<ActionOutcome> {
  const tier = tierFor(input.kind);
  const auto = executesImmediately(input.kind);

  return runPublishingTransaction(db, async (tx) => {
    const action = await tx.actionRequest.create({
      data: {
        jobId: input.jobId,
        tier,
        kind: input.kind,
        reason: input.reason,
        computedImpact: input.impact ?? {},
        // An AUTO action is recorded as already executed, because it is: the
        // caller runs it the moment this returns. Recording it PENDING and
        // then updating would leave a window where the table says a human owes
        // a decision they were never going to be asked for.
        status: auto ? 'EXECUTED' : 'PENDING',
        resolution: auto ? 'executed automatically (AUTO tier)' : null,
        resolvedAt: auto ? new Date() : null,
        requestedByRole: input.actor?.role ?? 'SYSTEM',
        requestedById: input.actor?.id ?? null,
      },
      select: { id: true, status: true },
    });

    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: `ACTION_${tier}`,
      payload: {
        actionRequestId: action.id,
        kind: input.kind,
        reason: input.reason,
        impact: input.impact ?? {},
      },
      actorRole: input.actor?.role ?? 'SYSTEM',
      actorId: input.actor?.id ?? null,
    });

    return { actionRequestId: action.id, tier, status: action.status, executeNow: auto };
  });
}

// ---------------------------------------------------------------------------
// Resolving one. RECOMMEND is executed by a dispatcher; APPROVE is signed off
// (or rejected) and the approver is recorded.

export type ResolveInput = {
  actionRequestId: string;
  decision: 'EXECUTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approver: { role: string; id: string | null };
  note?: string;
};

export type ResolveOutcome =
  | { outcome: 'RESOLVED'; status: ActionStatus }
  // Somebody already dealt with it. Not an error: two dispatchers can open the
  // same queue.
  | { outcome: 'ALREADY_RESOLVED'; status: ActionStatus };

export async function resolveAction(
  db: PrismaClient,
  input: ResolveInput,
): Promise<ResolveOutcome> {
  return runPublishingTransaction(db, async (tx) => {
    const action = await tx.actionRequest.findUnique({
      where: { id: input.actionRequestId },
      select: { id: true, jobId: true, tier: true, kind: true, status: true },
    });
    if (!action) return { outcome: 'ALREADY_RESOLVED', status: 'CANCELLED' } as const;

    // Conditional on it still being PENDING — the same shape as every other
    // two-writers guard in this codebase.
    const moved = await tx.actionRequest.updateMany({
      where: { id: input.actionRequestId, status: 'PENDING' },
      data: {
        status: input.decision,
        resolution: input.note ?? `${input.decision.toLowerCase()} by ${input.approver.role}`,
        resolvedAt: new Date(),
      },
    });

    if (moved.count === 0) {
      return { outcome: 'ALREADY_RESOLVED', status: action.status } as const;
    }

    // An APPROVE-tier action records WHO signed it off. A RECOMMEND executed
    // by a dispatcher does not need an approval row — it was never blocked.
    if (action.tier === 'APPROVE') {
      await tx.approvalRecord.create({
        data: {
          actionRequestId: action.id,
          approvedByRole: input.approver.role,
          approvedById: input.approver.id,
          decision: input.decision,
          note: input.note ?? null,
        },
      });
    }

    if (action.jobId) {
      await appendJobEvent(tx, {
        jobId: action.jobId,
        eventType: `ACTION_${input.decision}`,
        payload: { actionRequestId: action.id, kind: action.kind, note: input.note ?? null },
        actorRole: input.approver.role,
        actorId: input.approver.id,
      });
    }

    return { outcome: 'RESOLVED', status: input.decision } as const;
  });
}

// Is there already an unresolved action of this kind for this job? Used to
// stop a periodic sweep raising the same escalation every five minutes — an
// operator queue that refills itself is one nobody reads.
export async function hasOpenAction(
  db: PrismaClient,
  input: { jobId: string; kind: ActionKind },
): Promise<boolean> {
  const existing = await db.actionRequest.count({
    where: { jobId: input.jobId, kind: input.kind, status: 'PENDING' },
  });
  return existing > 0;
}
