// THE DAILY PAYOUT RUN — compute what each technician is owed, and commit to
// sending it.
//
// COMPUTED HERE, SENT AT PHASE 22b. This creates PayoutBatch and Payout rows in
// PENDING and moves the money on the LEDGER; no bank rail is touched and no
// provider is called. That split is deliberate and is the same one the payment
// provider follows: the rules about who is owed what are business logic and
// must be testable without a vendor.
//
// THREE OUTCOMES PER TECHNICIAN, and the rule is `payoutDecision` in the
// domain — pure, and already tested from stage 4:
//
//   PAY                  balance at or above the minimum. A Payout row, and
//                        the balance is accrued onto the payables account.
//   HOLD_BELOW_MINIMUM   too small to be worth a transfer. Rolls forward
//                        untouched, so tomorrow it is bigger.
//   CARRY_DEBT           they owe the platform — they collected more cash than
//                        they earned. NOTHING is sent and nothing is written:
//                        the debt stays on their ledger and is netted off the
//                        top of what they earn next, which happens for free
//                        because a balance is a SUM over an append-only log.
//
// "Paying out" a negative amount would mean taking money from a technician's
// bank account. No rail will do it and nobody agreed to it, so the code cannot
// express it: `payoutDecision` never returns PAY for a negative balance and
// this file only ever creates a Payout from a PAY.
//
// RESUMABLE, NOT MERELY IDEMPOTENT. A run that dies halfway leaves the batch
// row and some of its payouts. Re-entering finds the batch and works through
// the technicians it has not yet paid — refusing because the batch exists
// would strand the rest of them for a day. Two independent guards make that
// safe: `(batch_id, technician_id)` is unique, and each accrual's ledger
// transaction id is derived from the batch and the technician.

import type { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { payoutAccrualLines, payoutDecision, technicianAccountCode } from '../domain/ledger.js';
import { postTransaction } from './ledger.js';

export type PayoutRunInput = {
  // The day being paid. Its date is the batch reference, which is what makes
  // running twice on one day a no-op rather than a second payment.
  runAt?: Date;
  minimumPaise?: number;
};

export type PayoutRunResult = {
  batchId: string;
  reference: string;
  // What happened to every technician with a ledger account, so an operator
  // can answer "why was I not paid?" without reading the ledger.
  paid: number;
  heldBelowMinimum: number;
  carryingDebt: number;
  totalPaise: number;
};

// `payout-2026-09-01`. A date, not a timestamp: the reference IS the
// idempotency key for the day, and a run at 00:05 and a manual re-run at 09:00
// must be the same batch.
export function payoutReferenceFor(runAt: Date): string {
  return `payout-${runAt.toISOString().slice(0, 10)}`;
}

export async function runPayoutBatch(
  db: PrismaClient,
  input: PayoutRunInput = {},
): Promise<PayoutRunResult> {
  const runAt = input.runAt ?? new Date();
  const minimumPaise = input.minimumPaise ?? config.PAYOUT_MINIMUM_PAISE;
  const reference = payoutReferenceFor(runAt);

  // FIND OR CREATE, so a partial run can be resumed. `reference` is unique, so
  // two workers starting the same day's run cannot create two batches.
  const batch = await db.payoutBatch.upsert({
    where: { reference },
    update: {},
    create: { reference, status: 'PENDING', totalPaise: 0 },
    select: { id: true },
  });

  const balances = await technicianBalances(db);

  let paid = 0;
  let heldBelowMinimum = 0;
  let carryingDebt = 0;

  for (const entry of balances) {
    const decision = payoutDecision(entry.balancePaise, minimumPaise);

    if (decision.outcome === 'CARRY_DEBT') {
      carryingDebt += 1;
      continue;
    }
    if (decision.outcome === 'HOLD_BELOW_MINIMUM') {
      heldBelowMinimum += 1;
      continue;
    }

    const created = await accruePayout(db, {
      batchId: batch.id,
      reference,
      technicianId: entry.technicianId,
      amountPaise: decision.amountPaise,
      runAt,
    });
    if (created) paid += 1;
  }

  // THE BATCH TOTAL IS READ BACK FROM THE ROWS, never accumulated in the loop.
  // A resumed run only creates the payouts a previous attempt did not, so its
  // loop sees a fraction of the batch — and the total has to describe the whole
  // thing. Summing the rows is the only version that is right for both a first
  // run and a resumed one.
  const settled = await db.payout.aggregate({
    where: { batchId: batch.id },
    _sum: { amountPaise: true },
  });
  await db.payoutBatch.update({
    where: { id: batch.id },
    data: { totalPaise: settled._sum.amountPaise ?? 0 },
  });

  logger.info(
    { reference, paid, heldBelowMinimum, carryingDebt, totalPaise: settled._sum.amountPaise ?? 0 },
    'payout batch computed',
  );

  return {
    batchId: batch.id,
    reference,
    paid,
    heldBelowMinimum,
    carryingDebt,
    totalPaise: settled._sum.amountPaise ?? 0,
  };
}

// One technician's payout: the ledger accrual and the Payout row, in that
// order. Returns false when this technician is already in this batch, which is
// how a resumed run skips what it already did.
async function accruePayout(
  db: PrismaClient,
  input: {
    batchId: string;
    reference: string;
    technicianId: string;
    amountPaise: number;
    runAt: Date;
  },
): Promise<boolean> {
  // ACCRUED ON THE LEDGER FIRST. Without this the technician's balance is
  // untouched by batching, so tomorrow's run computes the same figure and
  // creates a second payout for money already promised — and the ledger,
  // summing to zero throughout, would never notice. Guarded by its own derived
  // transaction id, so a retry writes nothing.
  const posted = await postTransaction(db, {
    transactionId: `payout:${input.reference}:${input.technicianId}`,
    jobId: null,
    lines: payoutAccrualLines({
      technicianCode: technicianAccountCode(input.technicianId),
      amountPaise: input.amountPaise,
    }),
    at: input.runAt,
  });
  if (posted.outcome === 'ALREADY_POSTED') return false;

  await db.payout.create({
    data: {
      technicianId: input.technicianId,
      batchId: input.batchId,
      amountPaise: input.amountPaise,
      // PENDING until Phase 22b actually sends it.
      status: 'PENDING',
      periodEnd: input.runAt,
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// EVERY TECHNICIAN WITH A LEDGER ACCOUNT, AND WHAT THEY ARE OWED.
//
// Summed in the database rather than pulled into memory: this runs over every
// technician who has ever earned anything, and the point of a daily job is
// that it stays cheap as that number grows.

type TechnicianBalance = { technicianId: string; balancePaise: number };

async function technicianBalances(db: PrismaClient): Promise<TechnicianBalance[]> {
  const accounts = await db.ledgerAccount.findMany({
    where: { code: { startsWith: 'technician:' } },
    select: { id: true, code: true },
  });
  if (accounts.length === 0) return [];

  const sums = await db.ledgerEntry.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accounts.map((account) => account.id) } },
    _sum: { amountPaise: true },
  });
  const balanceByAccount = new Map(sums.map((row) => [row.accountId, row._sum.amountPaise ?? 0]));

  const candidates: TechnicianBalance[] = accounts.map((account) => ({
    technicianId: account.code.slice('technician:'.length),
    balancePaise: balanceByAccount.get(account.id) ?? 0,
  }));

  // A Payout has a foreign key to Technician, so an account whose technician
  // has been removed cannot be paid. Filtering here rather than letting the
  // insert fail keeps one deleted technician from stopping the whole run.
  const existing = await db.technician.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.technicianId) } },
    select: { id: true },
  });
  const known = new Set(existing.map((technician) => technician.id));

  const missing = candidates.filter((candidate) => !known.has(candidate.technicianId));
  if (missing.length > 0) {
    logger.warn(
      { count: missing.length },
      'ledger accounts exist for technicians that no longer do; skipping them',
    );
  }

  return candidates.filter((candidate) => known.has(candidate.technicianId));
}

// What a batch turned out to be, for an operator or a test.
export async function payoutBatchSummary(
  db: Prisma.TransactionClient,
  reference: string,
): Promise<{ status: string; totalPaise: number; payouts: number } | null> {
  const batch = await db.payoutBatch.findUnique({
    where: { reference },
    select: { status: true, totalPaise: true, _count: { select: { payouts: true } } },
  });
  if (!batch) return null;
  return { status: batch.status, totalPaise: batch.totalPaise, payouts: batch._count.payouts };
}
