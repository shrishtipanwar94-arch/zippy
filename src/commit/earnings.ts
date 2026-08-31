// THE THREE MONEY EVENTS THAT REACH THE LEDGER.
//
//   a job completes          the customer owes; the technician and the
//                            platform each have a claim on it
//   the driver pays cash     the customer's debt is discharged and the
//                            technician is holding money that is not all theirs
//   a technician is released the platform owes them for a wasted trip
//
// EVERY ONE IS IDEMPOTENT, and none of them needs a flag to be. The transaction
// id is DERIVED from what happened — `completion:<jobId>` — and
// `(transaction_id, account_id)` is unique, so a replay collides and the whole
// posting rolls back. That is invariant 6 satisfied by construction rather than
// by remembering.
//
// WHAT IS NOT HERE: payouts. This file computes and records what is OWED;
// sending it is stage 5. `payoutDecision` in the domain is the rule that stage
// has to obey and is already tested.

import type { PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import {
  cashCollectionLines,
  commissionPaise,
  compensationLines,
  completionLines,
  settlementBookingFor,
  technicianAccountCode,
} from '../domain/ledger.js';
import { usesGateway } from '../domain/settlementPath.js';
import { postTransaction, technicianBalance } from './ledger.js';
import type { PostResult } from './ledger.js';
import { approvedTotalFor } from './estimates.js';
import { calloutRate } from '../pricing/rateCard.js';
import { serviceTypeFor } from './settlement.js';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export type EarningsOutcome =
  | { outcome: 'RECORDED'; transactionId: string; earningsPaise: number; commissionPaise: number }
  | { outcome: 'ALREADY_RECORDED'; transactionId: string }
  | { outcome: 'NOTHING_TO_RECORD'; reason: string };

// ---------------------------------------------------------------------------
// A JOB COMPLETES.

export async function recordJobCompletion(
  db: PrismaClient,
  input: { jobId: string },
): Promise<EarningsOutcome> {
  const job = await db.job.findUnique({
    where: { id: input.jobId },
    // SETTLEMENT PATH AND TENANT, because WHO carries the cost of this job
    // depends on both. Reading them here was the fix for a booking that
    // charged a customer receivable on every path, including customers who owe
    // nothing — see src/domain/ledger.ts.
    select: { id: true, assignedTechnicianId: true, settlementPath: true, tenantId: true },
  });
  if (!job?.assignedTechnicianId) {
    return { outcome: 'NOTHING_TO_RECORD', reason: 'this job has no assigned technician' };
  }

  // WHAT THE CUSTOMER AGREED TO, not what anybody thinks the job was worth.
  // The approved estimate is stage 2's record of consent and is the only
  // number the ledger has any business booking.
  const totalPaise = await approvedTotalFor(db, job.id);
  if (totalPaise === null || totalPaise === 0) {
    return { outcome: 'NOTHING_TO_RECORD', reason: 'nothing was approved on this job' };
  }

  const commission = commissionPaise(totalPaise, config.PLATFORM_COMMISSION_BPS);
  const earningsPaise = totalPaise - commission;
  const transactionId = `completion:${job.id}`;

  // The credit side — the technician's earnings and the platform's margin — is
  // identical on every path. Only the debit side moves.
  const settlement = settlementBookingFor(job.settlementPath, job.tenantId);

  const posted = await postTransaction(db, {
    transactionId,
    jobId: job.id,
    lines: completionLines({
      technicianCode: technicianAccountCode(job.assignedTechnicianId),
      settlement,
      totalPaise,
      commissionPaise: commission,
    }),
  });
  if (posted.outcome === 'ALREADY_POSTED') {
    return { outcome: 'ALREADY_RECORDED', transactionId };
  }

  // The commission row is the platform's own record of the cut, separate from
  // the ledger entry: the ledger is the double-entry truth, and this is the
  // per-job line a finance report groups by technician.
  await runPublishingTransaction(db, async (tx) => {
    await tx.commission.create({
      data: {
        jobId: job.id,
        technicianId: job.assignedTechnicianId!,
        amountPaise: commission,
        rateBps: config.PLATFORM_COMMISSION_BPS,
        status: 'ACCRUED',
      },
    });
    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'EARNINGS_RECORDED',
      payload: {
        transactionId,
        totalPaise,
        earningsPaise,
        commissionPaise: commission,
        // Which account carried it, so "who was billed for this job?" is
        // answerable from the incident timeline and not only from the ledger.
        settlementAccount: settlement.accountCode,
      },
    });
  });

  return { outcome: 'RECORDED', transactionId, earningsPaise, commissionPaise: commission };
}

export async function recordJobCompletionQuietly(db: PrismaClient, jobId: string): Promise<void> {
  try {
    await recordJobCompletion(db, { jobId });
  } catch (error) {
    logger.error({ err: error, jobId }, 'could not record job earnings');
  }
}

// ---------------------------------------------------------------------------
// THE DRIVER PAID THE TECHNICIAN IN CASH.
//
// Most of the volume in India, and the case that makes this ledger worth
// building. The technician's balance goes NEGATIVE by the platform's
// commission, because they are holding money that is not all theirs.

export type CashOutcome =
  | { outcome: 'RECORDED'; transactionId: string; technicianBalancePaise: number }
  | { outcome: 'ALREADY_RECORDED'; transactionId: string }
  | { outcome: 'NOTHING_TO_RECORD'; reason: string };

export async function recordCashCollection(
  db: PrismaClient,
  input: { jobId: string; amountPaise: number },
): Promise<CashOutcome> {
  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: { id: true, assignedTechnicianId: true, settlementPath: true },
  });
  if (!job?.assignedTechnicianId) {
    return { outcome: 'NOTHING_TO_RECORD', reason: 'this job has no assigned technician' };
  }
  if (input.amountPaise <= 0) {
    return { outcome: 'NOTHING_TO_RECORD', reason: 'a cash collection must be positive' };
  }
  // ONLY A PER-INCIDENT PAYER CAN HAND OVER CASH. A fleet is invoiced monthly
  // and a covered consumer owes nothing, so cash on either path is somebody
  // taking money they should not have. Refusing also protects the books: this
  // transaction CREDITS the customer receivable, and on a path that never
  // debited it that would push the account positive — a customer in credit for
  // a job they never owed for.
  if (!job.settlementPath || !usesGateway(job.settlementPath)) {
    return {
      outcome: 'NOTHING_TO_RECORD',
      reason: `${job.settlementPath ?? 'unknown'} jobs are not settled in cash`,
    };
  }

  const technicianId = job.assignedTechnicianId;
  const transactionId = `cash:${job.id}`;

  const posted = await postTransaction(db, {
    transactionId,
    jobId: job.id,
    lines: cashCollectionLines({
      technicianCode: technicianAccountCode(technicianId),
      collectedPaise: input.amountPaise,
    }),
  });
  if (posted.outcome === 'ALREADY_POSTED') {
    return { outcome: 'ALREADY_RECORDED', transactionId };
  }

  await runPublishingTransaction(db, async (tx) => {
    await tx.cashCollection.create({
      data: {
        jobId: job.id,
        technicianId,
        amountPaise: input.amountPaise,
        // Un-reconciled until the technician hands the platform's share over.
        // Remittance is stage 5; this flag is what it will look for.
        reconciled: false,
      },
    });
    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'CASH_COLLECTED',
      payload: { transactionId, amountPaise: input.amountPaise, technicianId },
    });
  });

  const balance = await technicianBalance(db, technicianId);
  return { outcome: 'RECORDED', transactionId, technicianBalancePaise: balance };
}

// ---------------------------------------------------------------------------
// A TECHNICIAN WAS RELEASED AFTER ACCEPTING.
//
// Called from the saga's compensation path. They committed to a job and may
// have set off; the reservation then fell apart around them, and that is the
// dispatch system being wrong rather than the customer changing their mind —
// so the platform pays for it out of its own revenue line.
//
// IDEMPOTENT (invariant 6), and it has to be: `compensateSaga` is reachable
// from a live response, from the offer-expiry worker and from startup
// recovery, and all three can arrive for the same saga.

export type CompensationOutcome =
  | { outcome: 'RECORDED'; transactionId: string; amountPaise: number }
  | { outcome: 'ALREADY_RECORDED'; transactionId: string }
  | { outcome: 'NOTHING_TO_RECORD'; reason: string };

export async function recordReleaseCompensation(
  db: PrismaClient,
  input: { sagaId: string; jobId: string; technicianId: string },
): Promise<CompensationOutcome> {
  const amountPaise = await compensationAmountFor(db, input.jobId);
  if (amountPaise <= 0) {
    return { outcome: 'NOTHING_TO_RECORD', reason: 'no callout fee is priced for this job' };
  }

  // Keyed on the SAGA, not the job: a job can be reassigned several times and
  // each released technician is owed separately, but one saga compensating
  // twice is one debt.
  const transactionId = `compensation:${input.sagaId}`;

  const posted: PostResult = await postTransaction(db, {
    transactionId,
    jobId: input.jobId,
    lines: compensationLines({
      technicianCode: technicianAccountCode(input.technicianId),
      amountPaise,
    }),
  });
  if (posted.outcome === 'ALREADY_POSTED') {
    return { outcome: 'ALREADY_RECORDED', transactionId };
  }

  await runPublishingTransaction(db, async (tx) => {
    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'TECHNICIAN_COMPENSATED',
      payload: { transactionId, technicianId: input.technicianId, amountPaise },
    });
  });

  return { outcome: 'RECORDED', transactionId, amountPaise };
}

export async function recordReleaseCompensationQuietly(
  db: PrismaClient,
  input: { sagaId: string; jobId: string; technicianId: string },
): Promise<void> {
  try {
    await recordReleaseCompensation(db, input);
  } catch (error) {
    // A compensation that could not be booked must never fail the
    // compensation SAGA — the unit has to be released whatever the ledger
    // thinks. It is logged and the technician is owed either way.
    logger.error({ err: error, ...input }, 'could not record release compensation');
  }
}

// WHAT A WASTED TRIP IS WORTH: the job's callout fee, priced from the list the
// job was pinned to. Hand-set as a rule rather than measured — a technician who
// drove out is owed what the customer would have been charged for the callout,
// which is at least defensible and is a number the business already publishes.
async function compensationAmountFor(db: PrismaClient, jobId: string): Promise<number> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { priceListId: true, createdAt: true, onHighway: true },
  });
  if (!job?.priceListId) return 0;

  const callout = await calloutRate(db, {
    priceListId: job.priceListId,
    serviceType: serviceTypeFor(job.onHighway),
    at: job.createdAt,
  });
  return callout?.feePaise ?? 0;
}
