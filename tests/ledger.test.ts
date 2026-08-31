// THE LEDGER — Phase 15c stage 4, and the most rigorous part of this phase.
//
// EVERY money operation in this file is followed by `expectBalanced`, which
// asserts the transaction under test sums to zero AND that every transaction
// in the whole ledger still does. The brief asks for exactly that helper and
// exactly that discipline, and it is the reason a ledger is worth building:
// most claims about money are arguments, and this one is arithmetic.
//
// THE INVARIANT IS ALSO ENFORCED BY POSTGRES. A deferred constraint trigger
// rejects an unbalanced commit, so the tests below prove two separate things —
// that the application builds balanced transactions, and that the database
// would refuse them if it did not. The second is the one that survives a
// future phase nobody has written yet.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import {
  CASH_IN_TRANSIT_ACCOUNT,
  CUSTOMER_RECEIVABLE_ACCOUNT,
  PLATFORM_COMMISSION_ACCOUNT,
  cashCollectionLines,
  commissionPaise,
  compensationLines,
  completionLines,
  imbalanceOf,
  isBalanced,
  payoutDecision,
  technicianAccountCode,
} from '../src/domain/ledger.js';
import {
  UnbalancedTransactionError,
  accountBalance,
  ensurePlatformAccounts,
  postTransaction,
  technicianBalance,
} from '../src/commit/ledger.js';
import {
  recordCashCollection,
  recordJobCompletion,
  recordReleaseCompensation,
} from '../src/commit/earnings.js';
import { balanceOf, expectBalanced, expectLedgerBalances } from './helpers/ledgerBalance.js';

const PREFIX = 'ldg';
const TENANT = `${PREFIX}-tenant`;
const PRICE_LIST = `${PREFIX}-list`;

// A RUN-SCOPED ID, and the ledger's own design forces it.
//
// Every other suite in this project resets its fixture on the way in. This one
// CANNOT: `ledger_entries` is append-only and Postgres enforces it, so nothing
// here can delete what a previous run booked. And because every posting is
// idempotent on a derived transaction id, a second run against the same job
// ids would book NOTHING and every balance assertion would be reasoning about
// last run's numbers.
//
// So each run gets its own jobs, its own sagas and — crucially — its own
// TECHNICIANS, whose accounts therefore start at zero. That is not a workaround
// for a testing problem; it is what an immutable ledger actually requires of
// anybody who wants to assert a balance.
const RUN = Date.now().toString(36);
// Two technicians, because the cash story needs a balance that is purely its
// own: one who completes and is compensated, one who takes cash and goes into
// debt.
const TECH = `${PREFIX}-${RUN}-tech`;
const TECH_CASH = `${PREFIX}-${RUN}-tech-cash`;

function jobIdFor(suffix: string): string {
  return `${PREFIX}-${RUN}-job-${suffix}`;
}
const CREATED_AT = new Date('2021-06-01T00:00:00.000Z');
const CALLOUT_PAISE = 30000;

// The brief's own worked example: ₹2,340 total, 20% commission.
const TOTAL = 234000;
const COMMISSION = 46800;
const EARNINGS = TOTAL - COMMISSION; // 187200

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the shape of a balanced transaction', () => {
  it('books the brief’s worked example and it sums to zero', () => {
    const lines = completionLines({
      technicianCode: technicianAccountCode(TECH),
      totalPaise: TOTAL,
      commissionPaise: COMMISSION,
    });

    expect(lines.map((line) => line.amountPaise)).toEqual([EARNINGS, COMMISSION, -TOTAL]);
    expect(isBalanced(lines)).toBe(true);
    expect(imbalanceOf(lines)).toBe(0);
  });

  it('cash collection sums to zero and puts the technician in debt', () => {
    const lines = cashCollectionLines({
      technicianCode: technicianAccountCode(TECH),
      collectedPaise: TOTAL,
    });
    expect(isBalanced(lines)).toBe(true);
    // The customer's debt is discharged; the technician holds the lot.
    expect(lines.map((line) => line.amountPaise)).toEqual([TOTAL, -TOTAL]);
  });

  it('compensation sums to zero and the platform pays for it', () => {
    const lines = compensationLines({ technicianCode: technicianAccountCode(TECH), amountPaise: 30000 });
    expect(isBalanced(lines)).toBe(true);
    // Out of platform revenue, not out of a customer receivable — a released
    // technician is the dispatch system being wrong, not the customer.
    expect(lines.find((line) => line.accountCode === PLATFORM_COMMISSION_ACCOUNT)?.amountPaise).toBe(-30000);
  });

  it('rounds the commission down, in the technician’s favour', () => {
    // 20% of 999 paise is 199.8. The fraction goes to the technician.
    expect(commissionPaise(999, 2000)).toBe(199);
    expect(commissionPaise(TOTAL, 2000)).toBe(COMMISSION);
  });

  it('notices an imbalance', () => {
    expect(isBalanced([
      { accountCode: 'a', amountPaise: 100, memo: 'x' },
      { accountCode: 'b', amountPaise: -99, memo: 'y' },
    ])).toBe(false);
  });
});

describe('posting to the ledger', () => {
  it('refuses an unbalanced transaction before touching the database', async () => {
    await expect(
      postTransaction(prismaBase, {
        transactionId: `${PREFIX}-${RUN}-bad-1`,
        jobId: null,
        lines: [
          { accountCode: PLATFORM_COMMISSION_ACCOUNT, amountPaise: 100, memo: 'x' },
          { accountCode: CUSTOMER_RECEIVABLE_ACCOUNT, amountPaise: -99, memo: 'y' },
        ],
      }),
    ).rejects.toThrow(UnbalancedTransactionError);

    // Nothing was written, so the ledger is still sound.
    expect(await prismaBase.ledgerEntry.count({ where: { transactionId: `${PREFIX}-${RUN}-bad-1` } })).toBe(0);
    await expectLedgerBalances();
  });

  // THE DATABASE IS THE REAL GUARANTEE. Application code can be bypassed by a
  // repair script or a future phase; the deferred constraint trigger cannot.
  it('is refused by Postgres even when application code is bypassed', async () => {
    await ensurePlatformAccounts(prismaBase);
    const account = await prismaBase.ledgerAccount.findUniqueOrThrow({
      where: { code: PLATFORM_COMMISSION_ACCOUNT },
      select: { id: true },
    });

    await expect(
      prismaBase.ledgerEntry.create({
        data: {
          transactionId: `${PREFIX}-${RUN}-raw-unbalanced`,
          accountId: account.id,
          amountPaise: 500,
          memo: 'written straight past the domain',
        },
      }),
    ).rejects.toThrow(/does not balance/);

    expect(
      await prismaBase.ledgerEntry.count({ where: { transactionId: `${PREFIX}-${RUN}-raw-unbalanced` } }),
    ).toBe(0);
    await expectLedgerBalances();
  });

  // APPEND-ONLY. A correction is a new compensating transaction, never an edit.
  it('refuses to update or delete an entry', async () => {
    const transactionId = `${PREFIX}-${RUN}-immutable`;
    await postTransaction(prismaBase, {
      transactionId,
      jobId: null,
      lines: compensationLines({ technicianCode: technicianAccountCode(TECH), amountPaise: 1000 }),
    });
    await expectBalanced(transactionId);

    const entry = await prismaBase.ledgerEntry.findFirstOrThrow({
      where: { transactionId },
      select: { id: true },
    });

    await expect(
      prismaBase.ledgerEntry.update({ where: { id: entry.id }, data: { amountPaise: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prismaBase.ledgerEntry.delete({ where: { id: entry.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('posts the same transaction only once', async () => {
    const transactionId = `${PREFIX}-${RUN}-once`;
    const lines = compensationLines({ technicianCode: technicianAccountCode(TECH), amountPaise: 2500 });

    const first = await postTransaction(prismaBase, { transactionId, jobId: null, lines });
    const second = await postTransaction(prismaBase, { transactionId, jobId: null, lines });

    expect(first.outcome).toBe('POSTED');
    expect(second.outcome).toBe('ALREADY_POSTED');
    expect(await prismaBase.ledgerEntry.count({ where: { transactionId } })).toBe(2);
    await expectBalanced(transactionId);
  });
});

// ---------------------------------------------------------------------------

describe('a job completes', () => {
  const jobId = jobIdFor('complete');

  it('books earnings, commission and the receivable in one balanced transaction', async () => {
    await approveEstimate(jobId, TOTAL);

    const result = await recordJobCompletion(prismaBase, { jobId });
    expect(result.outcome).toBe('RECORDED');
    if (result.outcome !== 'RECORDED') return;
    expect(result.earningsPaise).toBe(EARNINGS);
    expect(result.commissionPaise).toBe(COMMISSION);

    const entries = await expectBalanced(result.transactionId);
    const byAccount = new Map(entries.map((e) => [e.account.code, e.amountPaise]));
    expect(byAccount.get(technicianAccountCode(TECH))).toBe(EARNINGS);
    expect(byAccount.get(PLATFORM_COMMISSION_ACCOUNT)).toBe(COMMISSION);
    expect(byAccount.get(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(-TOTAL);
  });

  it('records the commission row alongside the ledger', async () => {
    const commission = await prismaBase.commission.findFirstOrThrow({
      where: { jobId },
      select: { amountPaise: true, rateBps: true, status: true },
    });
    expect(commission.amountPaise).toBe(COMMISSION);
    expect(commission.rateBps).toBe(2000);
    expect(commission.status).toBe('ACCRUED');
  });

  it('books it once however many times completion fires', async () => {
    const again = await recordJobCompletion(prismaBase, { jobId });
    expect(again.outcome).toBe('ALREADY_RECORDED');
    expect(
      await prismaBase.ledgerEntry.count({ where: { transactionId: `completion:${jobId}` } }),
    ).toBe(3);
    await expectLedgerBalances();
  });

  it('books nothing for a job the customer never approved', async () => {
    const bare = jobIdFor('unapproved');
    const result = await recordJobCompletion(prismaBase, { jobId: bare });
    expect(result.outcome).toBe('NOTHING_TO_RECORD');
    await expectLedgerBalances();
  });
});

// ---------------------------------------------------------------------------

describe('the driver pays cash', () => {
  const jobId = jobIdFor('cash');

  it('discharges the customer and puts the technician in debt', async () => {
    await approveEstimate(jobId, TOTAL);
    const completion = await recordJobCompletion(prismaBase, { jobId });
    if (completion.outcome !== 'RECORDED') throw new Error('expected a completion');
    await expectBalanced(completion.transactionId);

    const before = await technicianBalance(prismaBase, TECH_CASH);

    const cash = await recordCashCollection(prismaBase, { jobId, amountPaise: TOTAL });
    expect(cash.outcome).toBe('RECORDED');
    if (cash.outcome !== 'RECORDED') return;
    await expectBalanced(cash.transactionId);

    // THE POINT OF THE WHOLE EXERCISE. They earned ₹1,872 and are holding
    // ₹2,340, so they now owe the platform its ₹468 commission — and their
    // balance is NEGATIVE by exactly that.
    expect(cash.technicianBalancePaise).toBe(before - TOTAL);
    expect(cash.technicianBalancePaise - before).toBe(-TOTAL);

    const collection = await prismaBase.cashCollection.findFirstOrThrow({
      where: { jobId },
      select: { amountPaise: true, reconciled: true },
    });
    expect(collection.amountPaise).toBe(TOTAL);
    // Un-reconciled until they hand the platform's share over — remittance is
    // stage 5, and this flag is what it will look for.
    expect(collection.reconciled).toBe(false);
  });

  it('leaves the platform its commission and the customer at zero', async () => {
    // The customer owed the total and then paid it: net zero for this job.
    // Both accounts are shared, so the assertion is on this job's own entries.
    const entries = await prismaBase.ledgerEntry.findMany({
      where: { jobId },
      select: { amountPaise: true, account: { select: { code: true } } },
    });
    const sumFor = (code: string) =>
      entries.filter((e) => e.account.code === code).reduce((sum, e) => sum + e.amountPaise, 0);

    expect(sumFor(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(0);
    expect(sumFor(PLATFORM_COMMISSION_ACCOUNT)).toBe(COMMISSION);
    // Earned 1,872, holding 2,340: they owe 468.
    expect(sumFor(technicianAccountCode(TECH_CASH))).toBe(EARNINGS - TOTAL);
    expect(sumFor(technicianAccountCode(TECH_CASH))).toBe(-COMMISSION);
    await expectLedgerBalances();
  });

  it('records a cash collection once', async () => {
    const again = await recordCashCollection(prismaBase, { jobId, amountPaise: TOTAL });
    expect(again.outcome).toBe('ALREADY_RECORDED');
    expect(await prismaBase.ledgerEntry.count({ where: { transactionId: `cash:${jobId}` } })).toBe(2);
    await expectLedgerBalances();
  });
});

// ---------------------------------------------------------------------------

describe('a payout never transfers a negative amount', () => {
  const MINIMUM = 50000; // ₹500

  it('pays a balance above the minimum', () => {
    expect(payoutDecision(120000, MINIMUM)).toEqual({ outcome: 'PAY', amountPaise: 120000 });
  });

  it('holds a balance below the minimum rather than sending it', () => {
    expect(payoutDecision(10000, MINIMUM)).toEqual({
      outcome: 'HOLD_BELOW_MINIMUM',
      balancePaise: 10000,
    });
  });

  // THE NON-OBVIOUS CASE, and the brief says to test it explicitly. A
  // technician who collected more cash than they earned owes the platform.
  // "Paying out" that negative would mean taking money from their bank
  // account, which no rail will do and nobody agreed to.
  it('carries a debt rather than transferring a negative amount', () => {
    const decision = payoutDecision(-46800, MINIMUM);
    expect(decision).toEqual({ outcome: 'CARRY_DEBT', balancePaise: -46800 });
    expect(decision.outcome).not.toBe('PAY');
  });

  it('nets the debt against future earnings rather than clearing it', async () => {
    // The technician is currently in debt from the cash job above.
    const owed = await technicianBalance(prismaBase, TECH_CASH);
    // Earned ₹1,872 on the cash job and took ₹2,340 in hand: they owe ₹468.
    expect(owed).toBe(-COMMISSION);
    expect(payoutDecision(owed, MINIMUM).outcome).toBe('CARRY_DEBT');

    // They do another job. The debt is not written off — it is netted, because
    // the balance is a running SUM over an append-only log and nothing ever
    // resets it.
    const nextJob = jobIdFor('next');
    await approveEstimate(nextJob, TOTAL);
    const completion = await recordJobCompletion(prismaBase, { jobId: nextJob });
    if (completion.outcome !== 'RECORDED') throw new Error('expected a completion');
    await expectBalanced(completion.transactionId);

    const after = await technicianBalance(prismaBase, TECH_CASH);
    expect(after).toBe(owed + EARNINGS);
    // And now they are payable again — the debt came off the top.
    expect(payoutDecision(after, MINIMUM).outcome).toBe('PAY');
  });

  it('treats exactly the minimum as payable', () => {
    expect(payoutDecision(MINIMUM, MINIMUM).outcome).toBe('PAY');
  });

  it('carries a zero balance as nothing to send', () => {
    expect(payoutDecision(0, MINIMUM).outcome).toBe('HOLD_BELOW_MINIMUM');
  });
});

// ---------------------------------------------------------------------------

describe('a released technician is compensated', () => {
  const jobId = jobIdFor('released');

  it('books the callout fee against platform revenue', async () => {
    const before = await technicianBalance(prismaBase, TECH);

    const result = await recordReleaseCompensation(prismaBase, {
      sagaId: `${PREFIX}-${RUN}-saga-1`,
      jobId,
      technicianId: TECH,
    });
    expect(result.outcome).toBe('RECORDED');
    if (result.outcome !== 'RECORDED') return;
    expect(result.amountPaise).toBe(CALLOUT_PAISE);

    const entries = await expectBalanced(result.transactionId);
    const byAccount = new Map(entries.map((e) => [e.account.code, e.amountPaise]));
    expect(byAccount.get(technicianAccountCode(TECH))).toBe(CALLOUT_PAISE);
    expect(byAccount.get(PLATFORM_COMMISSION_ACCOUNT)).toBe(-CALLOUT_PAISE);

    expect(await technicianBalance(prismaBase, TECH)).toBe(before + CALLOUT_PAISE);
  });

  // INVARIANT 6. `compensateSaga` is reachable from a live response, from the
  // offer-expiry worker and from startup recovery.
  it('compensates once however many times the saga compensates', async () => {
    const again = await recordReleaseCompensation(prismaBase, {
      sagaId: `${PREFIX}-${RUN}-saga-1`,
      jobId,
      technicianId: TECH,
    });
    expect(again.outcome).toBe('ALREADY_RECORDED');
    expect(
      await prismaBase.ledgerEntry.count({ where: { transactionId: `compensation:${PREFIX}-${RUN}-saga-1` } }),
    ).toBe(2);
    await expectLedgerBalances();
  });

  // Keyed on the SAGA, not the job: a job reassigned twice owes two
  // technicians, and each release is its own debt.
  it('compensates a second released technician on the same job', async () => {
    const result = await recordReleaseCompensation(prismaBase, {
      sagaId: `${PREFIX}-${RUN}-saga-2`,
      jobId,
      technicianId: TECH,
    });
    expect(result.outcome).toBe('RECORDED');
    await expectBalanced(`compensation:${PREFIX}-${RUN}-saga-2`);
  });
});

describe('the chart of accounts', () => {
  it('has the three platform accounts the brief names', async () => {
    await ensurePlatformAccounts(prismaBase);
    for (const code of [PLATFORM_COMMISSION_ACCOUNT, CUSTOMER_RECEIVABLE_ACCOUNT, CASH_IN_TRANSIT_ACCOUNT]) {
      const account = await prismaBase.ledgerAccount.findUnique({ where: { code } });
      expect(account, `${code} should exist`).not.toBeNull();
    }
  });

  it('creates a technician account on first use', async () => {
    const account = await prismaBase.ledgerAccount.findUnique({
      where: { code: technicianAccountCode(TECH) },
      select: { kind: true },
    });
    // What the platform owes them. Negative when they owe us instead.
    expect(account?.kind).toBe('LIABILITY');
  });

  it('reads a balance as a running sum, not a stored figure', async () => {
    const viaHelper = await balanceOf(technicianAccountCode(TECH));
    const viaApplication = await accountBalance(prismaBase, technicianAccountCode(TECH));
    expect(viaHelper).toBe(viaApplication);
  });

  it('leaves the whole ledger balanced at the end of this file', async () => {
    await expectLedgerBalances();
  });
});

// ---------------------------------------------------------------------------

async function approveEstimate(jobId: string, totalPaise: number): Promise<void> {
  const existing = await prismaBase.estimate.count({ where: { jobId, status: 'APPROVED' } });
  if (existing > 0) return;
  await prismaBase.estimate.create({
    data: {
      jobId,
      priceListId: PRICE_LIST,
      status: 'APPROVED',
      subtotalPaise: totalPaise,
      totalPaise,
      lines: {
        create: [
          { kind: 'CALLOUT', description: 'Callout', quantity: 1, unitPricePaise: CALLOUT_PAISE, amountPaise: CALLOUT_PAISE },
          { kind: 'LABOUR', description: 'Labour', quantity: 1, unitPricePaise: totalPaise - CALLOUT_PAISE, amountPaise: totalPaise - CALLOUT_PAISE },
        ],
      },
    },
  });
}

async function buildFixture(): Promise<void> {
  // THIS FILE'S LEDGER ENTRIES CANNOT BE DELETED — the table is append-only and
  // Postgres enforces it. So the fixture clears them the only legal way there
  // is: it does not. Every transaction id here is prefixed and every assertion
  // counts entries for a specific transaction, so a re-run finds its own rows
  // already present and the idempotency tests are the ones that would notice.
  //
  // The whole-ledger balance assertion is unaffected by accumulation, which is
  // exactly why it is safe to make a global claim about THIS property and not
  // about any other.
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Ledger Tenant', kind: 'CONSUMER' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'LDG',
      name: 'Ledger Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'Ledger Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-driver-user`,
      email: `${PREFIX}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-driver-user`, tenantId: TENANT },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'KA01LG0001',
      colour: 'Black',
    },
  });
  for (const technicianId of [TECH, TECH_CASH]) {
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

  await prismaBase.job.updateMany({ where: { priceListId: PRICE_LIST }, data: { priceListId: null } });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Ledger Fixture List',
      currency: 'INR',
      active: true,
      validFrom: new Date('2021-01-01T00:00:00.000Z'),
      validTo: new Date('2022-01-01T00:00:00.000Z'),
    },
  });
  await prismaBase.calloutFee.create({
    data: {
      priceListId: PRICE_LIST,
      serviceType: 'STANDARD',
      feePaise: CALLOUT_PAISE,
      validFrom: new Date('2021-01-01T00:00:00.000Z'),
    },
  });

  // Jobs are dated in the past so they never crowd `GET /jobs`, and their
  // estimates are cleared so each run books a fresh completion. The LEDGER
  // entries stay, because they cannot legally be removed.
  // The cash story belongs to its own technician, so its balance is purely its
  // own and the debt is unambiguous.
  const owners: Record<string, string> = {
    complete: TECH,
    unapproved: TECH,
    released: TECH,
    cash: TECH_CASH,
    next: TECH_CASH,
  };
  for (const [suffix, technicianId] of Object.entries(owners)) {
    const id = jobIdFor(suffix);
    await prismaBase.job.upsert({
      where: { id },
      update: { priceListId: PRICE_LIST, createdAt: CREATED_AT, assignedTechnicianId: technicianId },
      create: {
        id,
        tenantId: TENANT,
        driverId: `${PREFIX}-driver`,
        vehicleId: `${PREFIX}-vehicle`,
        zoneId: `${PREFIX}-zone`,
        priceListId: PRICE_LIST,
        status: 'WORKING',
        safetyLevel: 'NORMAL',
        createdAt: CREATED_AT,
        assignedTechnicianId: technicianId,
        onHighway: false,
        lat: 12.9352,
        lng: 77.6245,
      },
    });
  }
}
