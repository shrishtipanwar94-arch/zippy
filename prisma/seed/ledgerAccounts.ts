// THE PLATFORM'S CHART OF ACCOUNTS — the three that exist once, for everybody.
//
// Technician accounts are NOT seeded. There are thirty-one technicians today
// and there will be thousands, and an account with no entries is a row nobody
// reads; `src/commit/ledger.ts` creates one the first time a technician earns
// or owes something. These three are different: they are referenced by code
// from the first transaction the system ever posts, so they exist from the
// start rather than being conjured by whichever money operation happened to
// run first.
//
// The codes and kinds live in `src/domain/ledger.ts`, imported rather than
// repeated — a chart of accounts written down twice is a chart of accounts that
// will disagree with itself.

import type { PrismaClient } from '@prisma/client';
import { PLATFORM_ACCOUNTS } from '../../src/domain/ledger.js';

export async function seedLedgerAccounts(prisma: PrismaClient): Promise<void> {
  for (const account of PLATFORM_ACCOUNTS) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      update: { name: account.name, kind: account.kind },
      create: account,
    });
  }
}
