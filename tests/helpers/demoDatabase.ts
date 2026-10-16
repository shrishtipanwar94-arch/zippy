// A DATABASE OF ITS OWN FOR THE DEMO-BOARD TESTS.
//
// The demo board's crew B can do everything and carries everything — that is
// its job. On the shared `zippy_test` it would therefore win other suites'
// work: buildDispatchSnapshot reads the whole fleet, and B holds exactly the
// scarce capability pairs tests/redispatch*.test.ts isolate themselves with.
// That happened: with the demo crews briefly on the shared board,
// redispatch's "starts a real saga" test lost its job to B. Narrowing the
// window (taking the crews off in afterAll) was tried first and is not enough
// while vitest runs files in parallel.
//
// So the demo tests get `zippy_test_demo` on the same Postgres: created on
// first use, migrated with the real `prisma migrate deploy` (a no-op once up
// to date), and read by nobody else. The CLAUDE.md gotchas about a shared
// test database simply do not apply to it.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';

const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const DEMO_DATABASE = 'zippy_test_demo';

function urlFor(databaseName: string): string {
  const shared = process.env.DATABASE_URL;
  if (!shared) throw new Error('DATABASE_URL is not set for the test run');
  const url = new URL(shared);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createIfMissing(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } });
  try {
    const existing = await admin.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM pg_database WHERE datname = ${DEMO_DATABASE}`;
    if (existing.length === 0) {
      // CREATE DATABASE cannot take a bind parameter; the name is a constant.
      await admin.$executeRawUnsafe(`CREATE DATABASE ${DEMO_DATABASE}`);
    }
  } finally {
    await admin.$disconnect();
  }
}

export async function openDemoDatabase(): Promise<PrismaClient> {
  await createIfMissing();
  const url = urlFor(DEMO_DATABASE);
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  const db = new PrismaClient({ datasources: { db: { url } } });
  await db.$connect();
  return db;
}
