// PHASE 22b — executing Phase 15c's payout rows against RazorpayX, with no
// RazorpayX.
//
// Phase 15c computed what each technician was owed and wrote PENDING Payout
// rows; nothing sent them. This is the sending, and the three properties that
// matter are the ones nobody gets a second chance at:
//
//   NEVER TWICE           the idempotency key is derived from the batch and the
//                         technician, and a row already carrying a provider ref
//                         is skipped rather than re-sent.
//   A FAILURE GOES BACK   to PENDING with a reason, never to a terminal status
//                         somebody has to notice.
//   NEVER A NEGATIVE      a technician who owes the platform is never sent
//                         anything; their debt nets against what they earn next.
//
// RUN-SCOPED TECHNICIANS AND BATCHES, for the reason Phase 15c's payout suite
// discovered: `ledger_entries` is append-only and a batch reference is a DATE,
// so a suite that wants to assert a balance or a batch total must own rows whose
// entire history is its own.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { PAYOUTS_PAYABLE_ACCOUNT, PLATFORM_BANK_ACCOUNT, payoutDecision } from '../src/domain/ledger.js';
import { postTransaction } from '../src/commit/ledger.js';
import { technicianAccountCode } from '../src/domain/ledger.js';
import { executePayoutBatch } from '../src/commit/payoutExecution.js';
import { reconcilePayouts } from '../src/commit/paymentReconciliation.js';
import { resetRazorpayTransport, setRazorpayTransport } from '../src/payments/razorpayClient.js';
import type { RazorpayTransport } from '../src/payments/razorpayClient.js';
import { expectBalanced, balanceOf } from './helpers/ledgerBalance.js';

const PREFIX = 'rzp';
const RUN = Date.now().toString(36);

const PAYABLE = `${PREFIX}-${RUN}-payable`; // has a fund account, gets paid
const NO_ACCOUNT = `${PREFIX}-${RUN}-noaccount`; // nobody onboarded them
const REFUSED = `${PREFIX}-${RUN}-refused`; // the rail says no

const AMOUNT_PAISE = 187_200; // ₹1,872

// A batch reference this file owns outright. Phase 15c's reference is the DAY,
// which two suites running on one simulated date would share.
const REFERENCE = `payout-${PREFIX}-${RUN}`;

let batchId = '';

beforeAll(async () => {
  await buildFixture();
});

afterEach(() => {
  resetRazorpayTransport();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('a payout the rail accepts', () => {
  it('is sent once, marked SENT, and carries the provider reference', async () => {
    const calls: string[] = [];
    setRazorpayTransport(recordingTransport(calls, { id: 'pout_1', status: 'queued' }));

    const result = await executePayoutBatch(prismaBase, { reference: REFERENCE });
    expect(result.sent).toBe(1);

    const payout = await payoutFor(PAYABLE);
    // QUEUED IS NOT PAID. The rail accepted it; the money has not landed, and a
    // status that said otherwise would have the ledger recording a transfer
    // that has not happened.
    expect(payout.status).toBe('SENT');
    expect(payout.providerRef).toBe('pout_1');
    expect(calls).toEqual(['POST /v1/payouts']);
  });

  // THE IDEMPOTENCY KEY IS DERIVED, NEVER RANDOM. A random key on a retry is a
  // new key, and a new key is a second transfer.
  it('sends the batch and technician as the idempotency key', async () => {
    const headers: Record<string, string>[] = [];
    setRazorpayTransport(async (_url, init) => {
      headers.push(init.headers);
      return { status: 200, text: JSON.stringify({ id: 'pout_x', status: 'queued' }) };
    });

    // A second batch, so there is something left to send.
    await seedPayout(`${REFERENCE}-second`, PAYABLE, AMOUNT_PAISE);
    await executePayoutBatch(prismaBase, { reference: `${REFERENCE}-second` });

    expect(headers[0]?.['x-payout-idempotency-key']).toBe(
      `payout:${REFERENCE}-second:${PAYABLE}`,
    );
  });

  // THE SECOND LOCK, on top of the vendor's own idempotency. A row that already
  // carries a provider ref has demonstrably been handed to the rail — including
  // by an attempt that died before it could write the status.
  it('does not send a row that already has a provider reference', async () => {
    const calls: string[] = [];
    setRazorpayTransport(recordingTransport(calls, { id: 'pout_2', status: 'queued' }));

    await prismaBase.payout.updateMany({
      where: { batchId, technicianId: PAYABLE },
      data: { status: 'PENDING' },
    });

    const result = await executePayoutBatch(prismaBase, { reference: REFERENCE });

    expect(result.alreadySent).toBe(1);
    expect(result.sent).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('a payout the rail refuses', () => {
  it('goes back to PENDING with a reason, and is never half-sent', async () => {
    setRazorpayTransport(async () => ({
      status: 400,
      text: JSON.stringify({
        error: { code: 'BAD_REQUEST_ERROR', description: 'The beneficiary account is invalid' },
      }),
    }));

    const reference = `${REFERENCE}-refused`;
    await seedPayout(reference, REFUSED, AMOUNT_PAISE);
    const result = await executePayoutBatch(prismaBase, { reference });

    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(1);

    const payout = await payoutFor(REFUSED, reference);
    expect(payout.status).toBe('PENDING');
    expect(payout.providerRef).toBeNull();
    expect(payout.failureReason).toContain('beneficiary');
  });

  // INVARIANT 8. A technician nobody onboarded is a visible, recoverable state,
  // not a run that fell over.
  it('leaves a technician with no fund account pending, and finishes the batch', async () => {
    const calls: string[] = [];
    setRazorpayTransport(recordingTransport(calls, { id: 'pout_3', status: 'queued' }));

    const reference = `${REFERENCE}-mixed`;
    await seedPayout(reference, NO_ACCOUNT, AMOUNT_PAISE);
    await seedPayout(reference, REFUSED, AMOUNT_PAISE);

    const result = await executePayoutBatch(prismaBase, { reference });

    // One went out; the one with nobody to pay did not stop it.
    expect(result.sent).toBe(1);
    expect(result.deferred).toBe(1);

    const stranded = await payoutFor(NO_ACCOUNT, reference);
    expect(stranded.status).toBe('PENDING');
    expect(stranded.failureReason).toContain('fund account');
  });
});

describe('the ledger moves only when the money does', () => {
  // The accrual (technician -> payables) happened when the batch was computed.
  // This is the other half: payables -> bank, and only on a transfer that
  // actually landed.
  it('posts the settlement when the rail says processed', async () => {
    setRazorpayTransport(async () => ({
      status: 200,
      text: JSON.stringify({ id: 'pout_done', status: 'processed' }),
    }));

    const reference = `${REFERENCE}-processed`;
    await seedPayout(reference, PAYABLE, AMOUNT_PAISE);

    const payableBefore = await balanceOf(PAYOUTS_PAYABLE_ACCOUNT);
    const bankBefore = await balanceOf(PLATFORM_BANK_ACCOUNT);

    await executePayoutBatch(prismaBase, { reference });

    const payout = await payoutFor(PAYABLE, reference);
    expect(payout.status).toBe('PAID');

    const entries = await expectBalanced(`payout-sent:${reference}:${PAYABLE}`);
    expect(entries).toHaveLength(2);

    // The liability shrinks and the bank shrinks with it. Both move toward zero
    // together, which is what discharging a payable IS.
    expect(await balanceOf(PAYOUTS_PAYABLE_ACCOUNT)).toBe(payableBefore - AMOUNT_PAISE);
    expect(await balanceOf(PLATFORM_BANK_ACCOUNT)).toBe(bankBefore + AMOUNT_PAISE);
  });

  it('posts nothing at all when the transfer fails', async () => {
    setRazorpayTransport(async () => ({
      status: 400,
      text: JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'no' } }),
    }));

    const reference = `${REFERENCE}-noledger`;
    await seedPayout(reference, REFUSED, AMOUNT_PAISE);
    await executePayoutBatch(prismaBase, { reference });

    const entries = await prismaBase.ledgerEntry.count({
      where: { transactionId: `payout-sent:${reference}:${REFUSED}` },
    });
    // The technician is still owed and the payable still stands, so the right
    // entry for a failed transfer is no entry.
    expect(entries).toBe(0);
  });
});

describe('reconciling a payout stuck in flight', () => {
  // A payout accepted as `queued` becomes `processed` minutes later, and the
  // webhook saying so is exactly as droppable as the payment ones.
  it('settles a SENT payout the gateway says has landed', async () => {
    const reference = `${REFERENCE}-inflight`;
    await seedPayout(reference, PAYABLE, AMOUNT_PAISE);
    await prismaBase.payout.updateMany({
      where: { batch: { reference }, technicianId: PAYABLE },
      data: {
        status: 'SENT',
        providerRef: 'pout_inflight',
        sentAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    setRazorpayTransport(async () => ({
      status: 200,
      text: JSON.stringify({ id: 'pout_inflight', status: 'processed' }),
    }));

    const summary = await reconcilePayouts(prismaBase, { references: [reference] });
    expect(summary.settled).toBe(1);

    const payout = await payoutFor(PAYABLE, reference);
    expect(payout.status).toBe('PAID');
    await expectBalanced(`payout-sent:${reference}:${PAYABLE}`);
  });

  it('returns a reversed payout to PENDING so the next run sends it again', async () => {
    const reference = `${REFERENCE}-reversed`;
    await seedPayout(reference, REFUSED, AMOUNT_PAISE);
    await prismaBase.payout.updateMany({
      where: { batch: { reference }, technicianId: REFUSED },
      data: {
        status: 'SENT',
        providerRef: 'pout_reversed',
        sentAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    setRazorpayTransport(async () => ({
      status: 200,
      text: JSON.stringify({
        id: 'pout_reversed',
        status: 'reversed',
        failure_reason: 'the beneficiary bank returned it',
      }),
    }));

    const summary = await reconcilePayouts(prismaBase, { references: [reference] });
    expect(summary.returned).toBe(1);

    const payout = await payoutFor(REFUSED, reference);
    expect(payout.status).toBe('PENDING');
    // The provider ref is cleared, which is what makes the next run send it
    // rather than skip it as already handed over.
    expect(payout.providerRef).toBeNull();
  });
});

describe('a technician who owes the platform', () => {
  // THE RULE IS UPSTREAM AND STAYS UPSTREAM. `payoutDecision` never returns PAY
  // for a negative balance, so no Payout row is ever created and the executor
  // has nothing to send. The debt nets against future earnings for free,
  // because a balance is a SUM over an append-only log.
  it('is never sent anything, at any amount', () => {
    expect(payoutDecision(-46_800, 50_000).outcome).toBe('CARRY_DEBT');
    expect(payoutDecision(-1, 0).outcome).toBe('CARRY_DEBT');
  });

  // The second lock, on the door that is already shut. A non-positive amount
  // that somehow reached a Payout row is refused rather than handed to a rail.
  it('is refused by the executor even if a row somehow exists', async () => {
    const calls: string[] = [];
    setRazorpayTransport(recordingTransport(calls, { id: 'pout_never', status: 'queued' }));

    const reference = `${REFERENCE}-negative`;
    await seedPayout(reference, PAYABLE, 0);

    const result = await executePayoutBatch(prismaBase, { reference });

    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(1);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIXTURE.

async function payoutFor(technicianId: string, reference = REFERENCE) {
  return prismaBase.payout.findFirstOrThrow({
    where: { technicianId, batch: { reference } },
    select: { status: true, providerRef: true, failureReason: true, amountPaise: true },
  });
}

function recordingTransport(calls: string[], body: unknown): RazorpayTransport {
  return async (url, init) => {
    calls.push(`${init.method} ${url.replace('http://127.0.0.1:9', '')}`);
    return { status: 200, text: JSON.stringify(body) };
  };
}

// A batch with one PENDING payout in it, and the ledger accrual that would have
// put it there. Accrued rather than conjured so the settlement this file
// asserts on has something real to discharge.
async function seedPayout(
  reference: string,
  technicianId: string,
  amountPaise: number,
): Promise<void> {
  const batch = await prismaBase.payoutBatch.upsert({
    where: { reference },
    update: {},
    create: { reference, status: 'PENDING', totalPaise: 0 },
    select: { id: true },
  });

  if (amountPaise > 0) {
    await postTransaction(prismaBase, {
      transactionId: `payout:${reference}:${technicianId}`,
      jobId: null,
      lines: [
        {
          accountCode: technicianAccountCode(technicianId),
          amountPaise: -amountPaise,
          memo: 'earnings accrued to a payout',
        },
        {
          accountCode: PAYOUTS_PAYABLE_ACCOUNT,
          amountPaise,
          memo: 'payout awaiting transfer',
        },
      ],
    });
  }

  await prismaBase.payout.upsert({
    where: { batchId_technicianId: { batchId: batch.id, technicianId } },
    update: { status: 'PENDING', providerRef: null, failureReason: null },
    create: {
      technicianId,
      batchId: batch.id,
      amountPaise,
      status: 'PENDING',
      periodEnd: new Date('2020-06-01T00:00:00.000Z'),
    },
  });
}

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'RZP',
      name: 'Razorpay Payout Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });

  // Two of the three have a fund account; the third deliberately does not.
  const technicians: { id: string; fundAccountRef: string | null }[] = [
    { id: PAYABLE, fundAccountRef: 'fa_payable' },
    { id: REFUSED, fundAccountRef: 'fa_refused' },
    { id: NO_ACCOUNT, fundAccountRef: null },
  ];

  for (const technician of technicians) {
    await prismaBase.user.upsert({
      where: { id: `${technician.id}-user` },
      update: {},
      create: {
        id: `${technician.id}-user`,
        email: `${technician.id}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: 'Payout Fixture Technician',
      },
    });
    await prismaBase.technician.upsert({
      where: { id: technician.id },
      update: { payoutFundAccountRef: technician.fundAccountRef },
      create: {
        id: technician.id,
        userId: `${technician.id}-user`,
        employeeCode: technician.id,
        homeZoneId: `${PREFIX}-zone`,
        payoutFundAccountRef: technician.fundAccountRef,
      },
    });
  }

  await seedPayout(REFERENCE, PAYABLE, AMOUNT_PAISE);
  const batch = await prismaBase.payoutBatch.findUniqueOrThrow({
    where: { reference: REFERENCE },
    select: { id: true },
  });
  batchId = batch.id;
}
