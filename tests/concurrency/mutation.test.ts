// THE PROOF THAT THE CONCURRENCY TESTS ARE LOAD-BEARING.
//
// A passing test is not evidence. The only way to know a test protects
// something is to break the thing and watch it go red. This file breaks the
// unit hold's version check on purpose — `unsafeCreateHold` below is the
// production query from src/commit/holds.ts with `AND version = ${...}`
// deleted and nothing else changed — and pins exactly which races that clause
// is responsible for.
//
// SKIPPED IN CI, PRESENT IN THE REPO. It deliberately exercises a broken
// implementation, so it is not something to run on every push; it is the
// artifact you open when someone asks "how do you know those tests would
// catch a regression?". Run it with `npm run test:concurrency` locally.
//
// ---------------------------------------------------------------------------
// THE RESULT, WHICH IS NOT THE OBVIOUS ONE, and is the reason this file is
// worth reading.
//
// The build plan predicts that deleting the version check makes the
// two-dispatchers test fail. IT DOES NOT, and the measurement is below.
// `AND status = 'AVAILABLE'` is itself a conditional guard: when two UPDATEs
// hit the same row at READ COMMITTED, Postgres blocks the second on the first
// one's row lock, and when the first commits the second RE-EVALUATES its WHERE
// clause against the newly committed row. It sees `status = 'HELD'`, matches
// nothing, and reports zero rows. The simultaneous double-book is prevented by
// the status clause alone, and the version clause is doing no work in that
// scenario at all.
//
// What the version column actually protects is the STALE read — the ABA
// problem. A dispatcher reads a unit as AVAILABLE at version 4. Somebody else
// holds it and releases it. It is AVAILABLE again, at version 6. A status-only
// check cannot tell the difference between "still the unit I decided on" and
// "a unit that has been round the block since", so it accepts a claim whose
// entire justification — the plan that chose this unit — was computed against
// a world that no longer exists.
//
// That distinction is the whole reason the column exists, and neither the
// build plan's predicted failure nor the original two-dispatchers test would
// have found it. `holds.test.ts` now carries a test for it directly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startPostgres, seedFixture } from './harness.js';
import type { ConcurrencyHarness, Fixture } from './harness.js';
import { createHold } from '../../src/commit/holds.js';

// Present in the repo, off in CI — see the header.
const describeLocally = process.env.CI ? describe.skip : describe;

let harness: ConcurrencyHarness;
let prisma: PrismaClient;
let fixture: Fixture;

beforeAll(async () => {
  if (process.env.CI) return;
  harness = await startPostgres();
  prisma = harness.prisma;
  fixture = await seedFixture(prisma, { units: 6, jobs: 20, prefix: 'mut' });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
}, 60_000);

// THE MUTATION. Byte-for-byte the conditional update from
// src/commit/holds.ts::createHold, with the version clause removed.
async function unsafeCreateHold(
  unitId: string,
  jobId: string,
): Promise<{ outcome: 'HELD' | 'LOST_RACE' }> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw`
      UPDATE units
         SET status = 'HELD', version = version + 1, updated_at = now()
       WHERE id = ${unitId}
         AND status = 'AVAILABLE'
    `;
    if (claimed === 0) return { outcome: 'LOST_RACE' as const };

    await tx.unitHold.create({
      data: { unitId, jobId, status: 'ACTIVE', expiresAt: new Date(Date.now() + 60_000) },
    });
    return { outcome: 'HELD' as const };
  });
}

async function resetUnit(unitId: string): Promise<void> {
  await prisma.unit.update({
    where: { id: unitId },
    data: { status: 'AVAILABLE', version: { increment: 1 } },
  });
  await prisma.unitHold.updateMany({
    where: { unitId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'TEST_RESET' },
  });
}

describeLocally('deleting the version check', () => {
  // The negative result, asserted rather than assumed. If a future Postgres
  // version or isolation-level change made this start double-booking, this
  // test would fail and the comment above it would need rewriting — which is
  // exactly what a claim about database semantics should be pinned by.
  it('does NOT break the simultaneous case — the status clause already covers it', async () => {
    const unitId = fixture.unitIds[0]!;
    await resetUnit(unitId);

    const [a, b] = await Promise.all([
      unsafeCreateHold(unitId, fixture.jobIds[0]!),
      unsafeCreateHold(unitId, fixture.jobIds[1]!),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['HELD', 'LOST_RACE']);
    expect(await prisma.unitHold.count({ where: { unitId, status: 'ACTIVE' } })).toBe(1);
  });

  // The positive result: the race the version check is genuinely the only
  // thing standing in front of.
  it('DOES let a stale claim through, which the version check refuses', async () => {
    const safeUnit = fixture.unitIds[1]!;
    const unsafeUnit = fixture.unitIds[2]!;
    await resetUnit(safeUnit);
    await resetUnit(unsafeUnit);

    const staleVersion = (
      await prisma.unit.findUniqueOrThrow({ where: { id: safeUnit }, select: { version: true } })
    ).version;

    // Both units go round the block: held by someone else, then released.
    for (const unitId of [safeUnit, unsafeUnit]) {
      await prisma.unit.update({ where: { id: unitId }, data: { status: 'HELD', version: { increment: 1 } } });
      await prisma.unit.update({ where: { id: unitId }, data: { status: 'AVAILABLE', version: { increment: 1 } } });
    }

    // The real implementation refuses: the version it was told to expect is
    // not the version on the row.
    const safe = await createHold(prisma, {
      unitId: safeUnit,
      jobId: fixture.jobIds[2]!,
      expectedVersion: staleVersion,
    });
    expect(safe.outcome).toBe('LOST_RACE');

    // The mutated implementation has nothing to check against, sees an
    // AVAILABLE unit, and takes it — applying a decision made against a world
    // that has since changed twice.
    const unsafe = await unsafeCreateHold(unsafeUnit, fixture.jobIds[3]!);
    expect(unsafe.outcome).toBe('HELD');

    // Stated as the difference it makes: one unit correctly untouched, one
    // unit incorrectly claimed.
    expect(await prisma.unitHold.count({ where: { unitId: safeUnit, status: 'ACTIVE' } })).toBe(0);
    expect(await prisma.unitHold.count({ where: { unitId: unsafeUnit, status: 'ACTIVE' } })).toBe(1);
  });
});
