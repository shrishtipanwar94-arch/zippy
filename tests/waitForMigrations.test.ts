// THE WORKER WAITS FOR MIGRATIONS INSTEAD OF CRASHING ON A MISSING TABLE.
//
// The first Railway deploy crashed the worker: it queried dispatch_offers
// before the web process had created it. src/infra/waitForMigrations.ts now
// holds the worker until every migration the image ships has been applied.
// The loop takes its reader and its clock as inputs, so it is tested here
// without a database or real waiting.

import { describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { missingMigrations, waitForMigrations, waitUntilApplied } from '../src/infra/waitForMigrations.js';

const SHIPPED = ['001_init', '002_offers', '003_parts'];

describe('missingMigrations', () => {
  it('names exactly the shipped migrations the database has not finished', () => {
    expect(missingMigrations(SHIPPED, ['001_init'])).toEqual(['002_offers', '003_parts']);
    expect(missingMigrations(SHIPPED, SHIPPED)).toEqual([]);
  });
});

describe('waitUntilApplied', () => {
  it('waits, with growing gaps, until the web process has migrated', async () => {
    const answers = [[], ['001_init'], SHIPPED];
    const slept: number[] = [];

    await waitUntilApplied({
      expected: SHIPPED,
      readApplied: async () => answers.shift() ?? SHIPPED,
      maxWaitMs: 60_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([1_000, 2_000]);
  });

  it('gives up with the missing names once the budget is spent, so the platform restarts it', async () => {
    const attempt = waitUntilApplied({
      expected: SHIPPED,
      readApplied: async () => ['001_init'],
      maxWaitMs: 5_000,
      sleep: async () => undefined,
    });

    await expect(attempt).rejects.toThrow(/002_offers, 003_parts/);
  });
});

describe('waitForMigrations against the real test database', () => {
  it('returns at once when every shipped migration is applied', async () => {
    await expect(waitForMigrations(prismaBase)).resolves.toBeUndefined();
  });
});
