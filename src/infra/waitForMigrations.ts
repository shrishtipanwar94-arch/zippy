// WAIT FOR THE DATABASE SCHEMA BEFORE THE WORKER TOUCHES IT.
//
// Migrations run in exactly one place: the web process, on boot
// (scripts/start-process.sh). The worker starts at the same moment, so on a
// first deploy — or any deploy that adds a migration — it can reach the
// database before the web process has finished migrating it. That is not
// hypothetical: the very first Railway deploy crashed the worker with
// "The table `public.dispatch_offers` does not exist", from saga recovery,
// the first query it runs.
//
// So the worker compares the migrations this image SHIPS (the folders in
// prisma/migrations) with the ones the database has FINISHED applying
// (`_prisma_migrations`), and waits, with growing gaps, until every one is
// there. If they never arrive it throws, the process exits non-zero, and the
// platform's restart-on-failure policy starts it again (docs/DEPLOYMENT.md).

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

// Long enough to cover a slow migration on a cold database, short enough that
// a genuinely broken deploy shows up as a restarting worker within minutes.
const MAX_WAIT_MS = 5 * 60_000;
const FIRST_DELAY_MS = 1_000;
const LONGEST_DELAY_MS = 15_000;

export function missingMigrations(expected: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return expected.filter((name) => !done.has(name));
}

export type WaitInput = {
  expected: string[];
  readApplied: () => Promise<string[]>;
  maxWaitMs: number;
  sleep: (ms: number) => Promise<void>;
};

// The loop, with its inputs passed in so a test can run it without a database
// or a real clock. Doubles the delay each time, capped at LONGEST_DELAY_MS.
export async function waitUntilApplied(input: WaitInput): Promise<void> {
  let waitedMs = 0;
  let delayMs = FIRST_DELAY_MS;

  for (;;) {
    const missing = missingMigrations(input.expected, await input.readApplied());
    if (missing.length === 0) return;

    if (waitedMs >= input.maxWaitMs) {
      throw new Error(
        `gave up after ${Math.round(waitedMs / 1000)}s waiting for ${missing.length} migration(s) ` +
          `to be applied: ${missing.join(', ')}. Migrations run on the web process's boot — check its logs.`,
      );
    }

    logger.info({ missing: missing.length, retryInMs: delayMs }, 'waiting for migrations before starting');
    await input.sleep(delayMs);
    waitedMs += delayMs;
    delayMs = Math.min(delayMs * 2, LONGEST_DELAY_MS);
  }
}

// Every migration folder this image was built with. Relative to the working
// directory, which is the repository root locally and /app in the image.
function shippedMigrations(): string[] {
  const directory = join(process.cwd(), 'prisma', 'migrations');
  const entries = readdirSync(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names;
}

async function appliedMigrations(db: PrismaClient): Promise<string[]> {
  // A brand-new database has no _prisma_migrations table yet: nothing applied.
  // Asked first rather than caught, because Prisma prints every failed raw
  // query to stderr even when the caller handles it, and "relation does not
  // exist" in a worker's boot log reads exactly like the crash this prevents.
  const [table] = await db.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`;
  if (!table?.present) return [];

  const rows = await db.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return rows.map((row) => row.migration_name);
}

export async function waitForMigrations(db: PrismaClient): Promise<void> {
  await waitUntilApplied({
    expected: shippedMigrations(),
    readApplied: () => appliedMigrations(db),
    maxWaitMs: MAX_WAIT_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
