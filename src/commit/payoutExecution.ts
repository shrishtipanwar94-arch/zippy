// SENDING THE MONEY — the half of Phase 15c's payout run that was left for
// Phase 22b. The run computed what each technician is owed and wrote PENDING
// Payout rows; this hands those rows to RazorpayX.
//
// PENDING -> SENT -> PAID, and PENDING again if it failed. Three properties
// hold across that, and each is enforced by a different mechanism rather than
// by this function being careful:
//
//   NEVER TWICE. The idempotency key is `payout:<batch reference>:<technician
//   id>` — derived, so a retry produces the same key — and RazorpayX honours it
//   directly. On top of that, a row already carrying a `provider_ref` has
//   demonstrably been handed to the rail and is skipped here rather than sent
//   again. A random key would defeat both.
//
//   A FAILURE GOES BACK TO PENDING, never to a FAILED status of its own. The
//   money is still owed; a terminal failure state would need somebody to notice
//   it, and the whole point of a daily run is that nobody has to. The reason is
//   kept on the row so it is visible (invariant 8) without being load-bearing.
//
//   A NEGATIVE BALANCE IS NEVER SENT. It cannot reach here — `payoutDecision`
//   returns CARRY_DEBT for a technician who owes the platform and no Payout row
//   is created, so their debt simply nets against what they earn next. The
//   guard below is the second lock on a door that is already shut, and it is
//   worth having because the thing on the other side of it is taking money out
//   of somebody's bank account.
//
// THE LEDGER MOVES ONLY WHEN THE MONEY DOES. The accrual (technician ->
// payables) happened at batch time; the settlement (payables -> bank) is posted
// here and only on a PROCESSED transfer. A payout accepted as `queued` has not
// arrived, so it books nothing yet — the reconciliation worker posts it when
// the gateway says it landed.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { payoutSettlementLines } from '../domain/ledger.js';
import { postTransaction } from './ledger.js';
import { sendPayout } from '../payments/razorpayPayouts.js';
import type { PayoutProgress } from '../payments/razorpayPayouts.js';

// How many batches one pass will work through. A batch nobody could pay — a
// fleet with no fund accounts — must not make every later run scan an
// ever-growing list of failures.
const BATCH_LOOKBACK = 7;

export type PayoutExecutionResult = {
  reference: string;
  sent: number;
  alreadySent: number;
  // Left PENDING: no fund account, a refusal, or a gateway we could not reach.
  deferred: number;
};

export async function executePayoutBatch(
  db: PrismaClient,
  input: { reference: string },
): Promise<PayoutExecutionResult> {
  const batch = await db.payoutBatch.findUnique({
    where: { reference: input.reference },
    select: { id: true },
  });
  if (!batch) return { reference: input.reference, sent: 0, alreadySent: 0, deferred: 0 };

  const payouts = await db.payout.findMany({
    where: { batchId: batch.id, status: 'PENDING' },
    select: {
      id: true,
      technicianId: true,
      amountPaise: true,
      providerRef: true,
      technician: { select: { payoutFundAccountRef: true } },
    },
  });

  let sent = 0;
  let alreadySent = 0;
  let deferred = 0;

  for (const payout of payouts) {
    // Already handed to the rail by an attempt that died before it could write
    // the status. Left for reconciliation to finish rather than sent again.
    if (payout.providerRef) {
      alreadySent += 1;
      continue;
    }
    if (payout.amountPaise <= 0) {
      await deferPayout(db, payout.id, 'a payout must be a positive amount');
      deferred += 1;
      continue;
    }
    const fundAccountRef = payout.technician.payoutFundAccountRef;
    if (!fundAccountRef) {
      await deferPayout(db, payout.id, 'this technician has no payout fund account');
      deferred += 1;
      continue;
    }

    const result = await sendPayout({
      idempotencyKey: `payout:${input.reference}:${payout.technicianId}`,
      fundAccountRef,
      amountPaise: payout.amountPaise,
    });

    if (result.outcome !== 'ACCEPTED') {
      await deferPayout(db, payout.id, result.reason);
      deferred += 1;
      continue;
    }

    await recordPayoutAccepted(db, {
      payoutId: payout.id,
      technicianId: payout.technicianId,
      amountPaise: payout.amountPaise,
      reference: input.reference,
      payoutRef: result.payoutRef,
      progress: result.progress,
    });
    sent += 1;
  }

  await closeBatchIfFinished(db, batch.id, input.reference);
  return { reference: input.reference, sent, alreadySent, deferred };
}

// THE PRODUCTION ENTRY POINT. Every batch that still has work in it, oldest
// first, so a payout that failed on Monday is retried on Tuesday without
// anybody re-running Monday's batch by hand.
//
// `references` NARROWS IT, for the reason `retryPendingAuthorisations` has the
// same option: `zippy_test` is shared and a test calling a function that
// operates on EVERY batch would settle another suite's rows and assert against
// a number somebody else moved.
export async function executeUnfinishedPayoutBatches(
  db: PrismaClient,
  options: { references?: string[] } = {},
): Promise<PayoutExecutionResult[]> {
  const batches = await db.payoutBatch.findMany({
    where: {
      status: { not: 'PROCESSED' },
      ...(options.references ? { reference: { in: options.references } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LOOKBACK,
    select: { reference: true },
  });

  const results: PayoutExecutionResult[] = [];
  for (const batch of batches) {
    results.push(await executePayoutBatch(db, { reference: batch.reference }));
  }
  return results;
}

// ---------------------------------------------------------------------------

async function deferPayout(db: PrismaClient, payoutId: string, reason: string): Promise<void> {
  await db.payout.update({
    where: { id: payoutId },
    data: { status: 'PENDING', failureReason: reason },
  });
  logger.warn({ payoutId, reason }, 'a payout was left pending and will be retried');
}

async function recordPayoutAccepted(
  db: PrismaClient,
  input: {
    payoutId: string;
    technicianId: string;
    amountPaise: number;
    reference: string;
    payoutRef: string;
    progress: PayoutProgress;
  },
): Promise<void> {
  // WRITTEN BEFORE ANYTHING ELSE, because between here and the next line is the
  // dual-write window this whole phase is about: the transfer has been accepted
  // and if this process dies now, only the provider ref proves it. Storing it
  // first is what lets the retry above skip a row rather than pay it twice.
  await db.payout.update({
    where: { id: input.payoutId },
    data: {
      status: input.progress === 'PROCESSED' ? 'PAID' : 'SENT',
      providerRef: input.payoutRef,
      failureReason: null,
      sentAt: new Date(),
    },
  });

  if (input.progress === 'PROCESSED') {
    await settlePayoutOnLedger(db, {
      reference: input.reference,
      technicianId: input.technicianId,
      amountPaise: input.amountPaise,
    });
  }
}

// The money left the building. Idempotent through its derived transaction id,
// so a webhook and the reconciliation worker both reporting the same processed
// payout post it once.
export async function settlePayoutOnLedger(
  db: PrismaClient,
  input: { reference: string; technicianId: string; amountPaise: number },
): Promise<void> {
  await postTransaction(db, {
    transactionId: `payout-sent:${input.reference}:${input.technicianId}`,
    jobId: null,
    lines: payoutSettlementLines({ amountPaise: input.amountPaise }),
  });
}

// A batch is done when nothing in it is still waiting. Read back from the rows
// rather than tracked in a counter, the same way `runPayoutBatch` reads its own
// total back — a resumed pass sees only part of the batch and must not draw a
// conclusion about the whole of it from that.
export async function closeBatchIfFinished(
  db: PrismaClient,
  batchId: string,
  reference: string,
): Promise<void> {
  const unfinished = await db.payout.count({
    where: { batchId, status: { in: ['PENDING', 'SENT'] } },
  });
  if (unfinished > 0) return;

  await db.payoutBatch.update({
    where: { id: batchId },
    data: { status: 'PROCESSED', processedAt: new Date() },
  });
  logger.info({ reference }, 'every payout in this batch has been transferred');
}
