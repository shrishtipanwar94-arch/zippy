// DOUBLE ENTRY — the shape of a balanced transaction, and nothing else.
//
// THE ONE INVARIANT, and it is the most rigorous testable property in this
// project:
//
//   for any transactionId, SUM(LedgerEntry.amount) = 0
//
// A ledger that balances is CHECKABLE, and a ledger that does not is a bug you
// can PROVE. That is worth more than any amount of careful reasoning about
// money, and it is why this file exists separately from the database: the
// shape of every transaction the system can write is decided here, in pure
// functions a test can enumerate, and `src/commit/ledger.ts` only persists what
// these return.
//
// THE SIGN CONVENTION, stated once so nothing has to guess it:
//
//   POSITIVE  this account is OWED that much, or has EARNED it.
//   NEGATIVE  this account OWES that much, or holds value belonging to others.
//
// So a completed job reads: the technician is owed their earnings (+), the
// platform has earned its commission (+), and the customer owes the total (−).
// The three sum to zero because the customer's debt is exactly the two claims
// against it. A technician who takes cash goes NEGATIVE, because they are now
// holding money that is not all theirs — which is the case the whole payout
// netting rule exists for.
//
// APPEND-ONLY, ENFORCED IN POSTGRES. A correction is a new compensating
// transaction, never an edit, and the database refuses UPDATE and DELETE on
// this table (Phase 1 trigger). The balance itself is a DEFERRED constraint
// trigger added in Phase 15c stage 4 — so an unbalanced transaction cannot be
// committed even by a hand-written SQL statement.

import type { Paise } from './money.js';
import { sumPaise } from './money.js';

// ---------------------------------------------------------------------------
// THE ACCOUNTS.

export const ACCOUNT_KINDS = ['ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'CLEARING'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

// The three accounts that exist once for the whole platform. Technician
// accounts are per technician and their codes are derived below.
export const PLATFORM_COMMISSION_ACCOUNT = 'platform:commission';
export const CUSTOMER_RECEIVABLE_ACCOUNT = 'customer:receivable';
// Cash a technician has collected and not yet handed over. Its first WRITER is
// remittance, which is stage 5 — the account is defined here because the
// ledger's chart of accounts is a whole thing or it is nothing, and because a
// technician's negative balance is meaningless without somewhere for the cash
// to go when they settle up.
export const CASH_IN_TRANSIT_ACCOUNT = 'cash-in-transit';

export function technicianAccountCode(technicianId: string): string {
  return `technician:${technicianId}`;
}

export const PLATFORM_ACCOUNTS: { code: string; name: string; kind: AccountKind }[] = [
  { code: PLATFORM_COMMISSION_ACCOUNT, name: 'Platform commission', kind: 'REVENUE' },
  { code: CUSTOMER_RECEIVABLE_ACCOUNT, name: 'Customer receivable', kind: 'ASSET' },
  { code: CASH_IN_TRANSIT_ACCOUNT, name: 'Cash in transit', kind: 'CLEARING' },
];

// ---------------------------------------------------------------------------
// A TRANSACTION, before it is written.

export type LedgerLine = {
  accountCode: string;
  amountPaise: Paise;
  // What this line is FOR. Every entry carries one, because a ledger you
  // cannot read is a ledger nobody will trust when it disagrees with a bank
  // statement.
  memo: string;
};

export function isBalanced(lines: LedgerLine[]): boolean {
  return sumPaise(lines.map((line) => line.amountPaise)) === 0;
}

export function imbalanceOf(lines: LedgerLine[]): Paise {
  return sumPaise(lines.map((line) => line.amountPaise));
}

// ---------------------------------------------------------------------------
// THE PLATFORM'S CUT.

export function commissionPaise(totalPaise: Paise, rateBps: number): Paise {
  // Rounded DOWN, and the direction is a choice: a fraction of a paise in
  // dispute goes to the technician rather than to the platform. It is half a
  // paise per job and it is the right half to give away.
  return Math.floor((totalPaise * rateBps) / 10_000);
}

// ---------------------------------------------------------------------------
// THE THREE TRANSACTIONS THIS PHASE CAN WRITE.

// A JOB IS COMPLETED. The customer owes the total; of that, the technician is
// owed their earnings and the platform has earned its commission.
export function completionLines(input: {
  technicianCode: string;
  totalPaise: Paise;
  commissionPaise: Paise;
}): LedgerLine[] {
  const earningsPaise = input.totalPaise - input.commissionPaise;
  return [
    { accountCode: input.technicianCode, amountPaise: earningsPaise, memo: 'job earnings' },
    {
      accountCode: PLATFORM_COMMISSION_ACCOUNT,
      amountPaise: input.commissionPaise,
      memo: 'platform commission',
    },
    {
      accountCode: CUSTOMER_RECEIVABLE_ACCOUNT,
      amountPaise: -input.totalPaise,
      memo: 'customer owes the job total',
    },
  ];
}

// THE DRIVER PAID THE TECHNICIAN IN CASH — most of the volume in India, and
// the case that makes this ledger interesting.
//
// The customer's debt is discharged: they have paid. The technician now
// physically holds the whole amount, of which only their earnings are theirs,
// so their claim on the platform drops by the FULL amount collected. Their
// balance ends up at earnings minus total — which is exactly minus the
// commission. THEY NOW OWE THE PLATFORM, and their balance is negative.
//
// Two entries, not three: splitting the technician's side into "earnings
// settled" and "commission owed" would need two entries on one account, which
// the (transaction, account) unique index forbids — and one signed amount says
// the same thing.
export function cashCollectionLines(input: {
  technicianCode: string;
  collectedPaise: Paise;
}): LedgerLine[] {
  return [
    {
      accountCode: CUSTOMER_RECEIVABLE_ACCOUNT,
      amountPaise: input.collectedPaise,
      memo: 'customer paid the technician in cash',
    },
    {
      accountCode: input.technicianCode,
      amountPaise: -input.collectedPaise,
      memo: 'technician holds the collected cash',
    },
  ];
}

// A TECHNICIAN WAS RELEASED AFTER ACCEPTING. They committed to a job, may have
// set off, and the reservation then fell apart around them. They are owed
// something for that, and the platform is the one that owes it — this is a
// cost of the dispatch system being wrong, not of the customer changing their
// mind, so it is booked against platform revenue rather than a receivable.
export function compensationLines(input: {
  technicianCode: string;
  amountPaise: Paise;
}): LedgerLine[] {
  return [
    {
      accountCode: input.technicianCode,
      amountPaise: input.amountPaise,
      memo: 'compensation for a released assignment',
    },
    {
      accountCode: PLATFORM_COMMISSION_ACCOUNT,
      amountPaise: -input.amountPaise,
      memo: 'compensation paid to a released technician',
    },
  ];
}

// ---------------------------------------------------------------------------
// WHAT A PAYOUT WOULD ACTUALLY SEND.
//
// The rule, not the payout. Creating PayoutBatch rows is stage 5; this is the
// arithmetic that stage has to obey, written and tested now because it is the
// non-obvious case and the brief says to prove it explicitly.
//
// A NEGATIVE BALANCE IS NEVER TRANSFERRED. A technician who collected more
// cash than they earned owes the platform money, and "paying out" a negative
// amount would mean taking money from their bank account — which no payment
// rail will do and no technician agreed to. The debt stays on their ledger and
// is netted against what they earn next, which is what makes it a running
// account rather than a per-period settlement.
export type PayoutDecision =
  | { outcome: 'PAY'; amountPaise: Paise }
  // Below the minimum worth a bank transfer. Rolls forward.
  | { outcome: 'HOLD_BELOW_MINIMUM'; balancePaise: Paise }
  // They owe us. Netted against future earnings, never transferred.
  | { outcome: 'CARRY_DEBT'; balancePaise: Paise };

export function payoutDecision(balancePaise: Paise, minimumPaise: Paise): PayoutDecision {
  if (balancePaise < 0) return { outcome: 'CARRY_DEBT', balancePaise };
  if (balancePaise < minimumPaise) return { outcome: 'HOLD_BELOW_MINIMUM', balancePaise };
  return { outcome: 'PAY', amountPaise: balancePaise };
}
