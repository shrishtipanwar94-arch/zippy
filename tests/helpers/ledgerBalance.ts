// THE BALANCE ASSERTION — used after every single money operation.
//
// The brief calls this "the single most rigorous testable property in the
// project", and the reason is worth stating: a ledger that balances is
// CHECKABLE, and a ledger that does not is a bug you can PROVE. Most claims
// about money in a system are arguments; this one is arithmetic.
//
// TWO ASSERTIONS, and they catch different things.
//
//   `expectTransactionBalances`   one transaction sums to zero. Catches a
//                                 caller that built the wrong lines.
//   `expectLedgerBalances`        EVERY transaction in the database sums to
//                                 zero. Catches an operation that wrote a
//                                 transaction nobody thought to check, which
//                                 is the failure a per-transaction assertion
//                                 cannot see.
//
// The second is a whole-database claim, which this project normally forbids
// (CLAUDE.md: never assert a raw table count). The exception is deliberate and
// is the one case where the global claim is the RIGHT one: "every transaction
// ever written balances" is not a fact about how quiet the database is, it is
// the invariant itself, and it is true no matter what any other suite writes
// concurrently. A parallel test writing a BALANCED transaction cannot break
// it; one writing an unbalanced transaction SHOULD break it.

import { expect } from 'vitest';
import { prismaBase } from '../../src/infra/prismaBase.js';

// One transaction. Returns the entries so a caller can go on to assert what
// the individual lines were.
export async function expectTransactionBalances(transactionId: string) {
  const entries = await prismaBase.ledgerEntry.findMany({
    where: { transactionId },
    select: { amountPaise: true, memo: true, account: { select: { code: true } } },
  });

  expect(entries.length, `transaction ${transactionId} has no entries`).toBeGreaterThan(0);

  const total = entries.reduce((sum, entry) => sum + entry.amountPaise, 0);
  expect(total, `transaction ${transactionId} does not balance`).toBe(0);

  return entries;
}

// EVERY transaction in the ledger. Grouped in the database rather than pulled
// into memory, because this runs after every money operation in the suite and
// the point is for it to stay cheap enough that nobody is tempted to skip it.
export async function expectLedgerBalances(): Promise<void> {
  const unbalanced = await prismaBase.$queryRaw<{ transaction_id: string; total: bigint }[]>`
    SELECT "transaction_id", SUM("amount_paise") AS total
      FROM "ledger_entries"
     GROUP BY "transaction_id"
    HAVING SUM("amount_paise") <> 0
  `;

  expect(
    unbalanced.map((row) => ({ transactionId: row.transaction_id, imbalancePaise: Number(row.total) })),
    'every ledger transaction must sum to zero',
  ).toEqual([]);
}

// The convenience both of the above are usually wanted together: check the one
// transaction under test, then check the ledger as a whole is still sound.
export async function expectBalanced(transactionId: string) {
  const entries = await expectTransactionBalances(transactionId);
  await expectLedgerBalances();
  return entries;
}

// What a named account holds, for tests that care about the resulting position
// rather than the entries. Reads through the same aggregate the application
// does, so a test cannot pass against arithmetic the product does not use.
export async function balanceOf(code: string): Promise<number> {
  const account = await prismaBase.ledgerAccount.findUnique({
    where: { code },
    select: { id: true },
  });
  if (!account) return 0;
  const total = await prismaBase.ledgerEntry.aggregate({
    where: { accountId: account.id },
    _sum: { amountPaise: true },
  });
  return total._sum.amountPaise ?? 0;
}
