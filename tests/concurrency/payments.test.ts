// INVARIANT 9, APPLIED TO MONEY: two callers authorising the same job at once.
//
// THE RACE THIS PINS, and it is one Phase 22b created rather than found.
//
// Until this phase there was exactly one caller of `authoriseCallout`: the
// dispatch path, once, when a reservation committed. Phase 22b added a second —
// POST /jobs/:id/checkout, which the driver's phone calls when they tap Pay now
// — and the two can overlap for real. A driver watching the page tap the button
// while the saga is still committing is not a contrived interleaving; it is a
// person being quick.
//
// `authoriseCallout` read the payment row and created one if it found none.
// Under that overlap both callers read "no payment", both inserted, and the
// loser died on the `idempotency_key` unique index — a 500 on the driver's
// phone, for a payment that had in fact been created correctly by the other
// caller. It was found by clicking Pay now on a real page against a real
// gateway, which is the only reason it was found at all: the fast suite calls
// the function once.
//
// THE FIX IS THE UNIQUE KEY, NOT A LOCK. `upsert` on `idempotency_key` makes
// Postgres decide, in one statement, and hands the loser the winner's row. That
// is the same shape as every other idempotency claim in this codebase — the
// ledger's transaction id, the payout's (batch, technician), the gateway
// event's (provider, event id).
//
// WHAT WOULD FAIL IF THE FIX WERE REVERTED: `bothSucceed` throws, and
// `onePaymentRow` never runs. Both assertions are here because they fail
// differently — one proves nobody saw an error, the other proves the database
// is not carrying a duplicate charge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startPostgres, seedFixture } from './harness.js';
import type { ConcurrencyHarness, Fixture } from './harness.js';
import { authoriseCallout } from '../../src/commit/payments.js';
import { StubProvider } from '../../src/payments/stubProvider.js';

let harness: ConcurrencyHarness;
let prisma: PrismaClient;
let fixture: Fixture;

const PRICE_LIST = 'pay-conc-list';
const CALLOUT_PAISE = 30000;

beforeAll(async () => {
  harness = await startPostgres();
  prisma = harness.prisma;
  fixture = await seedFixture(prisma, { units: 2, jobs: 4, prefix: 'payconc' });

  // A price list this container owns outright, and a callout fee on it. Without
  // both, `authoriseCallout` returns CANNOT_PRICE and never reaches the insert
  // the race is about.
  await prisma.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Concurrency fixture list',
      currency: 'INR',
      active: true,
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
    },
  });
  await prisma.calloutFee.create({
    data: {
      priceListId: PRICE_LIST,
      serviceType: 'STANDARD',
      feePaise: CALLOUT_PAISE,
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
    },
  });

  // WALK_IN is the only settlement path that touches a gateway at all — a fleet
  // is invoiced and a covered consumer owes nothing, and both return NO_GATEWAY
  // long before any row is written.
  await prisma.job.updateMany({
    where: { id: { in: fixture.jobIds } },
    data: { settlementPath: 'WALK_IN', priceListId: PRICE_LIST, onHighway: false },
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
}, 60_000);

describe('two callers authorise one job at the same moment', () => {
  it('both succeed — neither sees a unique constraint error', async () => {
    const jobId = fixture.jobIds[0]!;
    // ONE PROVIDER SHARED BY BOTH, because a real gateway is shared too: the
    // stub dedupes on the idempotency key, so this also proves the two callers
    // agree on that key and place one hold rather than two.
    const provider = new StubProvider();

    const [first, second] = await Promise.all([
      authoriseCallout(prisma, { jobId, provider }),
      authoriseCallout(prisma, { jobId, provider }),
    ]);

    // Whichever order they land in, neither is an error. One authorises; the
    // other either authorises the same hold or finds it already done.
    for (const result of [first, second]) {
      expect(['AUTHORISED', 'ALREADY_AUTHORISED']).toContain(result.outcome);
    }
  });

  it('leaves exactly one payment row', async () => {
    const jobId = fixture.jobIds[0]!;

    const payments = await prisma.payment.findMany({
      where: { jobId },
      select: { id: true, idempotencyKey: true, amountPaise: true },
    });

    expect(payments).toHaveLength(1);
    expect(payments[0]!.idempotencyKey).toBe(`auth-${jobId}`);
    // The callout fee, once — not twice, and not doubled.
    expect(payments[0]!.amountPaise).toBe(CALLOUT_PAISE);
  });

  it('holds the fee once at the provider, not twice', async () => {
    const jobId = fixture.jobIds[1]!;
    const provider = new StubProvider();

    await Promise.all([
      authoriseCallout(prisma, { jobId, provider }),
      authoriseCallout(prisma, { jobId, provider }),
      authoriseCallout(prisma, { jobId, provider }),
    ]);

    const payment = await prisma.payment.findFirstOrThrow({
      where: { jobId },
      select: { externalRef: true },
    });
    expect(payment.externalRef).toBeTruthy();

    // ASSERTED ON THE PROVIDER'S OWN VIEW, not on our rows. A test that only
    // counted payment rows would pass even if we had placed three holds on a
    // customer's card and recorded one of them.
    const held = provider.heldAmount(payment.externalRef!);
    expect(held?.amountPaise).toBe(CALLOUT_PAISE);
  });
});
