// THE DRIVER'S ANSWER — approve, decline, or cancel.
//
// Three answers, and the middle one is the interesting one.
//
//   APPROVE  the revised scope is agreed. The approval is RECORDED with what
//            was approved and when, and work resumes.
//   DECLINE  "do not do the extra work." This is NOT a rejection of the job:
//            the previously approved scope still stands and the technician
//            finishes that. It is only meaningful against a prior approval —
//            see NOTHING_APPROVED below.
//   CANCEL   the driver wants no more of it at all. The job ends.
//
// AN APPROVAL IS A RECORD, NOT A FLAG. `estimate_approvals` stores who
// approved, in what role, through what channel and when — and because an
// estimate is immutable once issued (a revision is a NEW estimate, never an
// edit), the approval plus the estimate it points at is a complete answer to
// "what exactly did this customer agree to, and when?". That is the question a
// billing dispute is made of, and a boolean on the job could not answer it.
//
// RESUMING GOES TO WORKING, always. The pause can only have happened from
// ON_SITE, DIAGNOSING or WORKING, and in every one of those cases the thing
// that happens after a driver approves a cost is that the work begins. Storing
// which rung to return to would be state to keep correct for no gain.

import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { approvedPayableFor } from './estimates.js';

export type EstimateDecision = 'APPROVE' | 'DECLINE' | 'CANCEL';

export type RespondInput = {
  estimateId: string;
  decision: EstimateDecision;
  actor: { role: Role; id: string | null };
  // How the answer arrived. Recorded because "approved in the app" and
  // "approved on the phone to a dispatcher" are different evidentiary weights.
  channel?: string;
};

export type RespondOutcome =
  | { outcome: 'APPROVED'; jobId: string; totalPaise: number }
  // Declined, and the job carries on at the scope already agreed.
  | { outcome: 'DECLINED'; jobId: string; approvedTotalPaise: number }
  | { outcome: 'CANCELLED'; jobId: string }
  // Declining with nothing previously approved would leave the job paused with
  // no scope to finish and no way out. Refused, with the two answers that do
  // make sense named.
  | { outcome: 'NOTHING_APPROVED'; jobId: string }
  // Somebody already answered this one — a second tap, or the driver in the
  // app while a dispatcher answers on the phone.
  | { outcome: 'ALREADY_ANSWERED'; status: string }
  | { outcome: 'NOT_FOUND' };

export async function respondToEstimate(
  db: PrismaClient,
  input: RespondInput,
): Promise<RespondOutcome> {
  const estimate = await db.estimate.findUnique({
    where: { id: input.estimateId },
    select: { id: true, jobId: true, status: true, totalPaise: true, coveredPaise: true },
  });
  if (!estimate) return { outcome: 'NOT_FOUND' };

  if (input.decision === 'DECLINE') {
    const approved = await approvedPayableFor(db, estimate.jobId);
    if (approved === null) return { outcome: 'NOTHING_APPROVED', jobId: estimate.jobId };
  }

  return runPublishingTransaction(db, async (tx) => {
    // THE ARBITER. A conditional update on the status we expect to be leaving,
    // the same shape holds.ts, offers.ts and eventPromotions.ts use. Two
    // answers to one estimate would otherwise both record an approval and both
    // move the job.
    const claimed = await tx.estimate.updateMany({
      where: { id: estimate.id, status: 'SENT' },
      data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' },
    });
    if (claimed.count === 0) {
      const current = await tx.estimate.findUnique({
        where: { id: estimate.id },
        select: { status: true },
      });
      return { outcome: 'ALREADY_ANSWERED', status: current?.status ?? 'REJECTED' } as const;
    }

    if (input.decision === 'APPROVE') {
      // WHAT THEY ACTUALLY AGREED TO. A covered driver owes nothing, and an
      // approval on file for the full cost of the work would misrepresent
      // their consent — which is exactly the evidence a billing dispute turns
      // on.
      await recordApproval(tx, estimate.id, input, estimate.totalPaise - estimate.coveredPaise);
      await resumeWork(tx, estimate.jobId);
      await appendJobEvent(tx, {
        jobId: estimate.jobId,
        eventType: 'ESTIMATE_APPROVED',
        payload: {
          estimateId: estimate.id,
          totalPaise: estimate.totalPaise,
          // The number they actually said yes to.
          approvedAmountPaise: estimate.totalPaise - estimate.coveredPaise,
        },
        actorRole: input.actor.role,
        actorId: input.actor.id,
      });
      return { outcome: 'APPROVED', jobId: estimate.jobId, totalPaise: estimate.totalPaise } as const;
    }

    if (input.decision === 'DECLINE') {
      // The extra work is refused; the agreed work is not. The job resumes at
      // the scope the driver already approved.
      const approvedTotalPaise = (await approvedPayableFor(tx, estimate.jobId)) ?? 0;
      await resumeWork(tx, estimate.jobId);
      await appendJobEvent(tx, {
        jobId: estimate.jobId,
        eventType: 'ESTIMATE_DECLINED',
        payload: {
          estimateId: estimate.id,
          declinedTotalPaise: estimate.totalPaise,
          // What the technician may still do, on the record, so "finish at the
          // approved scope" is a number rather than an understanding.
          approvedTotalPaise,
        },
        actorRole: input.actor.role,
        actorId: input.actor.id,
      });
      return { outcome: 'DECLINED', jobId: estimate.jobId, approvedTotalPaise } as const;
    }

    await cancelJob(tx, estimate.jobId, input);
    return { outcome: 'CANCELLED', jobId: estimate.jobId } as const;
  });
}

async function recordApproval(
  tx: Prisma.TransactionClient,
  estimateId: string,
  input: RespondInput,
  approvedAmountPaise: number,
): Promise<void> {
  await tx.estimateApproval.create({
    data: {
      estimateId,
      approvedByRole: input.actor.role,
      approvedById: input.actor.id,
      channel: input.channel ?? 'APP',
      approvedAmountPaise,
    },
  });
}

// Conditional on the job actually being paused, so an approval arriving late —
// after a dispatcher cancelled the job, say — cannot resurrect it.
async function resumeWork(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  await tx.job.updateMany({
    where: { id: jobId, status: 'AWAITING_APPROVAL' },
    data: { status: 'WORKING', version: { increment: 1 } },
  });
}

// CANCELLING ENDS THE JOB AND NOTHING ELSE. What the driver owes for a
// technician who has already driven out and diagnosed is the cancellation
// policy's answer, and that is a later stage of this phase — deliberately not
// inlined here, because a settlement rule buried in a state transition is
// exactly what the brief says not to build.
//
// `JOB_CANCELLED` is already a replan trigger that terminates rather than
// re-solves (src/domain/replanTriggers.ts), so nothing tries to find another
// van for a job the customer has just ended.
async function cancelJob(
  tx: Prisma.TransactionClient,
  jobId: string,
  input: RespondInput,
): Promise<void> {
  await tx.job.updateMany({
    where: { id: jobId, status: { notIn: ['RESOLVED', 'CANCELLED'] } },
    data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } },
  });
  await appendJobEvent(tx, {
    jobId,
    eventType: 'JOB_CANCELLED',
    payload: { reason: 'the driver declined the estimate and cancelled the job' },
    actorRole: input.actor.role,
    actorId: input.actor.id,
  });
}
