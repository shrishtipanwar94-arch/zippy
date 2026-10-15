// INVARIANT 9, APPLIED TO ESTIMATES: two presses of "Send the driver a cost"
// landing at the same moment.
//
// THE RACE THIS PINS. `buildEstimate` checks for a standing estimate with the
// same priced inputs and answers with it — but two presses that arrive
// together both read "nothing standing", both price the work, and both insert.
// That is how a live job collected a stack of identical estimate cards.
//
// THE FIX IS THE UNIQUE INDEX, NOT THE CHECK. `current_for_job_id` carries the
// job id on exactly one row, so the second insert raises P2002 and its whole
// transaction rolls back. The loser then reads the winner's estimate and, the
// inputs being the same, answers with it — so neither caller sees an error.
//
// WHAT WOULD FAIL IF THE INDEX WERE DROPPED: `oneEstimate` counts two rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startPostgres, seedFixture } from './harness.js';
import type { ConcurrencyHarness, Fixture } from './harness.js';
import { buildEstimate } from '../../src/commit/estimates.js';

let harness: ConcurrencyHarness;
let prisma: PrismaClient;
let fixture: Fixture;

const PRICE_LIST = 'est-conc-list';
const LIST_FROM = new Date('2020-01-01T00:00:00.000Z');
const actor = { role: 'TECHNICIAN' as const, id: null };

beforeAll(async () => {
  harness = await startPostgres();
  prisma = harness.prisma;
  fixture = await seedFixture(prisma, { units: 1, jobs: 2, prefix: 'estconc' });

  // KEYS_LOCKED_IN consumes no parts, so a labour rate and a callout fee are
  // all the price list needs; a tow tariff lets the second test change an
  // input without touching the diagnosis.
  await prisma.priceList.create({
    data: { id: PRICE_LIST, name: 'Concurrency fixture list', currency: 'INR', active: true, validFrom: LIST_FROM },
  });
  await prisma.labourRate.create({
    data: { priceListId: PRICE_LIST, code: 'STANDARD', ratePerHourPaise: 60000, validFrom: LIST_FROM },
  });
  await prisma.calloutFee.create({
    data: { priceListId: PRICE_LIST, serviceType: 'STANDARD', feePaise: 30000, validFrom: LIST_FROM },
  });
  await prisma.towTariff.create({
    data: { priceListId: PRICE_LIST, towType: 'FLATBED', perKmPaise: 4000, minChargePaise: 50000, validFrom: LIST_FROM },
  });

  await prisma.job.updateMany({
    where: { id: { in: fixture.jobIds } },
    data: { status: 'WORKING', priceListId: PRICE_LIST, onHighway: false },
  });
  for (const jobId of fixture.jobIds) {
    await prisma.faultHypothesis.create({
      data: { jobId, distribution: {}, requiredCapabilityCodes: [], entropy: 0.1, topFault: 'KEYS_LOCKED_IN' },
    });
  }
}, 300_000);

afterAll(async () => {
  await harness?.stop();
}, 60_000);

describe('two presses of one estimate button at the same moment', () => {
  it('issues one estimate and answers the other press with it', async () => {
    const jobId = fixture.jobIds[0]!;

    const [first, second] = await Promise.all([
      buildEstimate(prisma, { jobId, actor }),
      buildEstimate(prisma, { jobId, actor }),
    ]);

    // Neither is an error: one issues, the other is told what was issued.
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['ISSUED', 'UNCHANGED']);
    const firstId = 'estimateId' in first ? first.estimateId : null;
    const secondId = 'estimateId' in second ? second.estimateId : null;
    expect(firstId).toBe(secondId);

    const oneEstimate = await prisma.estimate.count({ where: { jobId } });
    expect(oneEstimate).toBe(1);
    expect(await prisma.jobEvent.count({ where: { jobId, eventType: 'ESTIMATE_ISSUED' } })).toBe(1);
  });

  // The supersede path races too: both presses find the same standing
  // estimate, both try to replace it with the same revision.
  it('supersedes once when two presses carry the same revision', async () => {
    const jobId = fixture.jobIds[1]!;
    await buildEstimate(prisma, { jobId, actor });

    const results = await Promise.all([
      buildEstimate(prisma, { jobId, actor, towKilometres: 15 }),
      buildEstimate(prisma, { jobId, actor, towKilometres: 15 }),
    ]);

    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(['ISSUED', 'UNCHANGED']);
    // Two rows in all — the original and one revision — and one of them current.
    expect(await prisma.estimate.count({ where: { jobId } })).toBe(2);
    expect(await prisma.estimate.count({ where: { jobId, currentForJobId: jobId } })).toBe(1);
  });
});
