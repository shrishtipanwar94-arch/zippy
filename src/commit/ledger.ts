// WRITING TO THE LEDGER — the only path, and it refuses to write anything
// that does not balance.
//
// THREE LAYERS GUARD ONE INVARIANT, and each catches what the others cannot:
//
//   1. `src/domain/ledger.ts` builds the lines. Pure, enumerable, tested.
//   2. `postTransaction` refuses an unbalanced set BEFORE touching the
//      database, so the error names the imbalance in paise instead of arriving
//      as a Postgres exception at commit.
//   3. A DEFERRED CONSTRAINT TRIGGER in Postgres rejects the commit anyway.
//      That is the one that matters: it holds for a repair script, a
//      migration, and a future phase that never read this file.
//
// Layer 2 without layer 3 is a convention. Layer 3 without layer 2 is a worse
// error message. Both is a ledger.
//
// IDEMPOTENT BY CONSTRUCTION. A transaction id is derived from what happened —
// `completion:<jobId>`, not a random string — and `(transaction_id,
// account_id)` is unique, so posting the same event twice collides on its
// first entry and the whole posting rolls back. Nothing needs to remember to
// check whether it has already run.
//
// APPEND-ONLY. There is deliberately no update and no delete here. A mistake
// is corrected by posting a compensating transaction, and the database refuses
// anything else.

import type { Prisma, PrismaClient } from '@prisma/client';
import { PLATFORM_ACCOUNTS, imbalanceOf, technicianAccountCode } from '../domain/ledger.js';
import type { AccountKind, LedgerLine } from '../domain/ledger.js';
import { isUniqueViolation } from '../infra/prismaErrors.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export class UnbalancedTransactionError extends Error {
  constructor(
    readonly transactionId: string,
    readonly imbalancePaise: number,
  ) {
    super(
      `ledger transaction ${transactionId} does not balance: entries sum to ${imbalancePaise} paise`,
    );
    this.name = 'UnbalancedTransactionError';
  }
}

export type PostResult =
  | { outcome: 'POSTED'; transactionId: string; entryCount: number }
  // This exact transaction has been posted before. Not an error: a replayed
  // completion or a saga compensating twice is expected, and the right answer
  // is to change nothing.
  | { outcome: 'ALREADY_POSTED'; transactionId: string };

export type PostInput = {
  transactionId: string;
  jobId: string | null;
  lines: LedgerLine[];
  at?: Date;
};

export async function postTransaction(
  db: PrismaClient,
  input: PostInput,
): Promise<PostResult> {
  // LAYER 2. Checked before anything is written, so a bug in a caller produces
  // an error naming the imbalance rather than a constraint violation at commit.
  const imbalance = imbalanceOf(input.lines);
  if (imbalance !== 0) throw new UnbalancedTransactionError(input.transactionId, imbalance);
  if (input.lines.length === 0) {
    throw new UnbalancedTransactionError(input.transactionId, 0);
  }

  try {
    return await runPublishingTransaction(db, async (tx) => {
      const accountIds = await resolveAccounts(tx, input.lines);

      await tx.ledgerEntry.createMany({
        data: input.lines.map((line) => ({
          transactionId: input.transactionId,
          accountId: accountIds.get(line.accountCode)!,
          amountPaise: line.amountPaise,
          jobId: input.jobId,
          memo: line.memo,
          eventTime: input.at ?? new Date(),
        })),
      });

      return {
        outcome: 'POSTED',
        transactionId: input.transactionId,
        entryCount: input.lines.length,
      } as const;
    });
  } catch (error) {
    // The unique index did its job: this transaction is already in the ledger.
    if (isUniqueViolation(error)) {
      return { outcome: 'ALREADY_POSTED', transactionId: input.transactionId };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ACCOUNTS.

// Created on first use rather than pre-seeded for technicians: there are
// thirty-one today and there will be thousands, and an account with no entries
// is a row nobody reads. The platform's three are seeded by
// `ensurePlatformAccounts` because they are referenced by code from day one.
async function resolveAccounts(
  tx: Prisma.TransactionClient,
  lines: LedgerLine[],
): Promise<Map<string, string>> {
  const codes = [...new Set(lines.map((line) => line.accountCode))];
  const found = new Map<string, string>();

  for (const code of codes) {
    const account = await tx.ledgerAccount.upsert({
      where: { code },
      update: {},
      create: { code, name: nameFor(code), kind: kindFor(code) },
      select: { id: true },
    });
    found.set(code, account.id);
  }

  return found;
}

function nameFor(code: string): string {
  const platform = PLATFORM_ACCOUNTS.find((account) => account.code === code);
  if (platform) return platform.name;
  return code.startsWith('technician:') ? `Technician ${code.slice('technician:'.length)}` : code;
}

function kindFor(code: string): AccountKind {
  const platform = PLATFORM_ACCOUNTS.find((account) => account.code === code);
  if (platform) return platform.kind;
  // What the platform owes a technician. Negative when they owe us instead,
  // which is the cash-collection case.
  return 'LIABILITY';
}

export async function ensurePlatformAccounts(db: PrismaClient): Promise<void> {
  for (const account of PLATFORM_ACCOUNTS) {
    await db.ledgerAccount.upsert({
      where: { code: account.code },
      update: {},
      create: account,
    });
  }
}

// ---------------------------------------------------------------------------
// READING.

// A running total, not a stored figure. There is no `balance` column and there
// must not be one: a balance derived from an append-only log cannot drift from
// the entries, and a cached one eventually will. It costs a SUM over an
// indexed column, which is the right trade until somebody proves otherwise.
export async function accountBalance(db: PrismaClient, code: string): Promise<number> {
  const account = await db.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
  if (!account) return 0;

  const total = await db.ledgerEntry.aggregate({
    where: { accountId: account.id },
    _sum: { amountPaise: true },
  });
  return total._sum.amountPaise ?? 0;
}

export function technicianBalance(db: PrismaClient, technicianId: string): Promise<number> {
  return accountBalance(db, technicianAccountCode(technicianId));
}
