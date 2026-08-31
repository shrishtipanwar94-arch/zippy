// PAYOUTS — Phase 15c stage 5.
//
// The run computes what each technician is owed and creates PayoutBatch and
// Payout rows in PENDING. It sends nothing: no bank rail, no provider, no
// network. Phase 22b does that.
//
// THE INVARIANT STILL HOLDS THROUGHOUT. A payout is an accrual on the ledger —
// the technician's balance moves onto a payables account — so every assertion
// here is followed by the same `expectBalanced` helper stage 4 introduced. A
// payout run that unbalanced the books would be the worst possible bug in this
// file and it is exactly the one that cannot happen.
//
// RUN-SCOPED TECHNICIANS, for the reason stage 4 discovered: `ledger_entries`
// is append-only and every posting is idempotent, so a suite that wants to
// assert a BALANCE must own an account whose entire history is its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import {
  PAYOUTS_PAYABLE_ACCOUNT,
  payoutAccrualLines,
  payoutDecision,
  technicianAccountCode,
} from '../src/domain/ledger.js';
import { postTransaction, technicianBalance } from '../src/commit/ledger.js';
import { payoutReferenceFor, runPayoutBatch } from '../src/commit/payouts.js';
import { expectBalanced, expectLedgerBalances } from './helpers/ledgerBalance.js';

const PREFIX = 'pyt';
const RUN = Date.now().toString(36);

// Four technicians, one per outcome the run can produce, plus one who starts
// with nothing at all.
const RICH = `${PREFIX}-${RUN}-rich`; // well above the minimum
const SMALL = `${PREFIX}-${RUN}-small`; // earned something, below the minimum
const INDEBTED = `${PREFIX}-${RUN}-indebted`; // took cash, owes the platform
const EMPTY = `${PREFIX}-${RUN}-empty`; // an account with no entries

const MINIMUM = 50_000; // ₹500
const RICH_EARNINGS = 187_200; // ₹1,872
const SMALL_EARNINGS = 10_000; // ₹100
const DEBT = 46_800; // ₹468

const DAY_ONE = new Date('2034-04-01T02:00:00.000Z');
const DAY_TWO = new Date('2034-04-02T02:00:00.000Z');

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// Only this file's technicians. The run works over every technician in the
// database — including other suites' — so every assertion here names its own.
async function payoutFor(reference: string, technicianId: string) {
  const batch = await prismaBase.payoutBatch.findUniqueOrThrow({
    where: { reference },
    select: { id: true },
  });
  return prismaBase.payout.findFirst({
    where: { batchId: batch.id, technicianId },
    select: { amountPaise: true, status: true, periodEnd: true },
  });
}

// ---------------------------------------------------------------------------

describe('the reference is a date', () => {
  it('is the same for two runs on one day', () => {
    expect(payoutReferenceFor(new Date('2034-04-01T02:00:00.000Z'))).toBe('payout-2034-04-01');
    // A scheduled run at 02:00 and an operator re-running at 21:00 must be the
    // same batch, not two.
    expect(payoutReferenceFor(new Date('2034-04-01T21:30:00.000Z'))).toBe('payout-2034-04-01');
  });

  it('differs the next day', () => {
    expect(payoutReferenceFor(DAY_TWO)).toBe('payout-2034-04-02');
  });
});

describe('the accrual', () => {
  it('moves the balance onto payables and still sums to zero', () => {
    const lines = payoutAccrualLines({ technicianCode: 'technician:x', amountPaise: 100_000 });
    expect(lines.map((line) => line.amountPaise)).toEqual([-100_000, 100_000]);
    expect(lines.find((l) => l.accountCode === PAYOUTS_PAYABLE_ACCOUNT)?.amountPaise).toBe(100_000);
  });
});

describe('a daily run', () => {
  it('pays a technician above the minimum and clears their balance', async () => {
    const before = await technicianBalance(prismaBase, RICH);
    expect(before).toBe(RICH_EARNINGS);

    const result = await runPayoutBatch(prismaBase, { runAt: DAY_ONE, minimumPaise: MINIMUM });
    expect(result.reference).toBe('payout-2034-04-01');

    const payout = await payoutFor(result.reference, RICH);
    expect(payout?.amountPaise).toBe(RICH_EARNINGS);
    // PENDING: nothing has been sent. Phase 22b moves it.
    expect(payout?.status).toBe('PENDING');

    // THE BALANCE IS NOW ZERO, which is what stops tomorrow paying it again.
    expect(await technicianBalance(prismaBase, RICH)).toBe(0);
    await expectBalanced(`payout:${result.reference}:${RICH}`);
  });

  it('holds a balance below the minimum, untouched', async () => {
    expect(await payoutFor('payout-2034-04-01', SMALL)).toBeNull();
    // Untouched, so tomorrow it is still there and still growing.
    expect(await technicianBalance(prismaBase, SMALL)).toBe(SMALL_EARNINGS);
    await expectLedgerBalances();
  });

  // THE CASE THE BRIEF SINGLES OUT. A technician who collected more cash than
  // they earned owes the platform. Paying out a negative amount would mean
  // taking money from their bank account.
  it('never sends a negative amount, and leaves the debt on the ledger', async () => {
    expect(await payoutFor('payout-2034-04-01', INDEBTED)).toBeNull();
    // The debt is NOT written off and NOT transferred — it simply stays.
    expect(await technicianBalance(prismaBase, INDEBTED)).toBe(-DEBT);

    // No payout row anywhere in this batch carries a negative amount.
    const batch = await prismaBase.payoutBatch.findUniqueOrThrow({
      where: { reference: 'payout-2034-04-01' },
      select: { id: true },
    });
    const negative = await prismaBase.payout.count({
      where: { batchId: batch.id, amountPaise: { lt: 0 } },
    });
    expect(negative).toBe(0);
    await expectLedgerBalances();
  });

  it('ignores a technician with no entries at all', async () => {
    expect(await payoutFor('payout-2034-04-01', EMPTY)).toBeNull();
  });

  it('counts what it did', async () => {
    // The run covers every technician in a shared database, so the counts are
    // at-least assertions about this file's four.
    const result = await runPayoutBatch(prismaBase, { runAt: DAY_ONE, minimumPaise: MINIMUM });
    expect(result.heldBelowMinimum).toBeGreaterThanOrEqual(1);
    expect(result.carryingDebt).toBeGreaterThanOrEqual(1);
  });

  // Running twice on one day must not pay twice — the reference is the day.
  it('is a no-op when the same day is run again', async () => {
    const batchId = (
      await prismaBase.payoutBatch.findUniqueOrThrow({
        where: { reference: 'payout-2034-04-01' },
        select: { id: true },
      })
    ).id;
    const before = await prismaBase.payout.count({ where: { batchId } });

    const again = await runPayoutBatch(prismaBase, { runAt: DAY_ONE, minimumPaise: MINIMUM });
    expect(again.paid).toBe(0);

    expect(await prismaBase.payout.count({ where: { batchId } })).toBe(before);
    expect(await technicianBalance(prismaBase, RICH)).toBe(0);
    expect(
      await prismaBase.ledgerEntry.count({
        where: { transactionId: `payout:payout-2034-04-01:${RICH}` },
      }),
    ).toBe(2);
    await expectLedgerBalances();
  });

  it('records the batch total from its rows', async () => {
    const batch = await prismaBase.payoutBatch.findUniqueOrThrow({
      where: { reference: 'payout-2034-04-01' },
      select: { id: true, totalPaise: true, status: true },
    });
    const sum = await prismaBase.payout.aggregate({
      where: { batchId: batch.id },
      _sum: { amountPaise: true },
    });
    expect(batch.totalPaise).toBe(sum._sum.amountPaise ?? 0);
    expect(batch.status).toBe('PENDING');
  });
});

describe('the next day', () => {
  it('pays nothing to a technician whose balance was already accrued', async () => {
    const result = await runPayoutBatch(prismaBase, { runAt: DAY_TWO, minimumPaise: MINIMUM });
    expect(result.reference).toBe('payout-2034-04-02');
    // Their balance went to zero yesterday, so today they are below the
    // minimum and are held rather than paid a second time.
    expect(await payoutFor(result.reference, RICH)).toBeNull();
    await expectLedgerBalances();
  });

  // THE NETTING, end to end: the debt comes off the top of new earnings, and
  // only what is left over is ever paid.
  it('nets a debt against new earnings before paying anything', async () => {
    expect(await technicianBalance(prismaBase, INDEBTED)).toBe(-DEBT);

    // They earn again. Nothing writes off the debt — the balance is a SUM over
    // an append-only log, so it nets by itself.
    await postTransaction(prismaBase, {
      transactionId: `${PREFIX}-${RUN}-later-earnings`,
      jobId: null,
      lines: [
        {
          accountCode: technicianAccountCode(INDEBTED),
          amountPaise: RICH_EARNINGS,
          memo: 'a later job',
        },
        {
          accountCode: PAYOUTS_PAYABLE_ACCOUNT,
          amountPaise: -RICH_EARNINGS,
          memo: 'counter-entry for the fixture',
        },
      ],
    });
    await expectBalanced(`${PREFIX}-${RUN}-later-earnings`);

    expect(await technicianBalance(prismaBase, INDEBTED)).toBe(RICH_EARNINGS - DEBT);

    const third = new Date('2034-04-03T02:00:00.000Z');
    const result = await runPayoutBatch(prismaBase, { runAt: third, minimumPaise: MINIMUM });

    const payout = await payoutFor(result.reference, INDEBTED);
    // Paid the NET, not the gross. The ₹468 came off the top.
    expect(payout?.amountPaise).toBe(RICH_EARNINGS - DEBT);
    expect(await technicianBalance(prismaBase, INDEBTED)).toBe(0);
    await expectBalanced(`payout:${result.reference}:${INDEBTED}`);
  });
});

describe('the rule the run obeys', () => {
  it('is the same pure function stage 4 tested', () => {
    expect(payoutDecision(RICH_EARNINGS, MINIMUM).outcome).toBe('PAY');
    expect(payoutDecision(SMALL_EARNINGS, MINIMUM).outcome).toBe('HOLD_BELOW_MINIMUM');
    expect(payoutDecision(-DEBT, MINIMUM).outcome).toBe('CARRY_DEBT');
  });

  it('leaves the whole ledger balanced at the end of this file', async () => {
    await expectLedgerBalances();
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'PYT',
      name: 'Payout Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });

  for (const technicianId of [RICH, SMALL, INDEBTED, EMPTY]) {
    await prismaBase.user.upsert({
      where: { id: `${technicianId}-user` },
      update: {},
      create: {
        id: `${technicianId}-user`,
        email: `${technicianId}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: 'Fixture Technician',
      },
    });
    await prismaBase.technician.upsert({
      where: { id: technicianId },
      update: {},
      create: {
        id: technicianId,
        userId: `${technicianId}-user`,
        employeeCode: technicianId,
        homeZoneId: `${PREFIX}-zone`,
      },
    });
  }

  // OPENING BALANCES, posted straight to the ledger rather than driven through
  // whole jobs. This file is about the payout RUN, and stage 4 already proves
  // that completions and cash collections produce these balances — building
  // four jobs here would test that again and make the arithmetic harder to read.
  //
  // The counter-entry is the payables account, which keeps every fixture
  // transaction balanced and therefore acceptable to the database trigger. It
  // leaves that account non-zero, which is exactly what an un-transferred
  // payables account should look like.
  const openings: { technicianId: string; amountPaise: number }[] = [
    { technicianId: RICH, amountPaise: RICH_EARNINGS },
    { technicianId: SMALL, amountPaise: SMALL_EARNINGS },
    { technicianId: INDEBTED, amountPaise: -DEBT },
  ];
  for (const opening of openings) {
    await postTransaction(prismaBase, {
      transactionId: `${PREFIX}-${RUN}-opening-${opening.technicianId}`,
      jobId: null,
      lines: [
        {
          accountCode: technicianAccountCode(opening.technicianId),
          amountPaise: opening.amountPaise,
          memo: 'opening balance for the payout fixture',
        },
        {
          accountCode: PAYOUTS_PAYABLE_ACCOUNT,
          amountPaise: -opening.amountPaise,
          memo: 'counter-entry for the fixture',
        },
      ],
    });
  }

  // EMPTY gets an account with no entries, which is the case the run must
  // skip without producing a zero payout.
  await prismaBase.ledgerAccount.upsert({
    where: { code: technicianAccountCode(EMPTY) },
    update: {},
    create: {
      code: technicianAccountCode(EMPTY),
      name: 'Technician with nothing',
      kind: 'LIABILITY',
    },
  });
}
