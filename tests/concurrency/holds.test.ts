// INVARIANT 9: CONCURRENCY IS TESTED AGAINST A REAL POSTGRES, NEVER MOCKED.
//
// The five races the build plan names, each fired with a real `Promise.all`
// against a container this file started. Every one of them is a case where the
// wrong answer is not a crash but a plausible-looking success — two dispatchers
// both told "you got the unit", a technician told they accepted a job that also
// timed out, a unit freed twice and handed to someone who is already driving to
// a different call.
//
// WHAT MAKES THESE TESTS LOAD-BEARING rather than decorative: `mutation.test.ts`
// next to this file runs the same races against a copy of the hold query with
// the version check deleted, and pins exactly which of them the version check
// is responsible for. The answer is not the obvious one — see that file.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startPostgres, seedFixture } from './harness.js';
import type { ConcurrencyHarness, Fixture } from './harness.js';
import { createHold, releaseHold, consumeHold, DEFAULT_HOLD_TTL_MS } from '../../src/commit/holds.js';
import { proposeOffer, respondToOffer, timeoutOffer } from '../../src/commit/offers.js';

let harness: ConcurrencyHarness;
let prisma: PrismaClient;
let fixture: Fixture;

// Generous: pulling postgres:16-alpine on a cold machine dominates this.
beforeAll(async () => {
  harness = await startPostgres();
  prisma = harness.prisma;
  fixture = await seedFixture(prisma, { units: 10, jobs: 60, prefix: 'conc' });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
}, 60_000);

async function unitStatus(unitId: string): Promise<{ status: string; version: number }> {
  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: unitId },
    select: { status: true, version: true },
  });
  return unit;
}

// Return a unit to AVAILABLE between tests without going through the code
// under test — a helper that used `releaseHold` would make one test's setup
// depend on another test's subject.
async function forceAvailable(unitId: string): Promise<void> {
  await prisma.unit.update({
    where: { id: unitId },
    data: { status: 'AVAILABLE', version: { increment: 1 } },
  });
  await prisma.unitHold.updateMany({
    where: { unitId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'TEST_RESET' },
  });
}

describe('1. two dispatchers hold the same unit', () => {
  it('lets exactly one win, and tells the loser why', async () => {
    const unitId = fixture.unitIds[0]!;
    await forceAvailable(unitId);
    const { version } = await unitStatus(unitId);

    // Both read the same version — which is exactly what two dispatchers
    // looking at the same board do — and then both try to take it.
    const [first, second] = await Promise.all([
      createHold(prisma, { unitId, jobId: fixture.jobIds[0]!, expectedVersion: version }),
      createHold(prisma, { unitId, jobId: fixture.jobIds[1]!, expectedVersion: version }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['HELD', 'LOST_RACE']);

    // And the loser is not merely rejected — it is told what it lost to.
    const loser = first.outcome === 'LOST_RACE' ? first : second;
    if (loser.outcome !== 'LOST_RACE') throw new Error('expected a loser');
    expect(loser.detail).toMatch(/HELD|version/);

    // ONE hold row, not two. This is the assertion that would fail on a
    // double-booking even if both callers were somehow told they won.
    const active = await prisma.unitHold.count({ where: { unitId, status: 'ACTIVE' } });
    expect(active).toBe(1);
    expect((await unitStatus(unitId)).status).toBe('HELD');
  });

  // THE TEST THAT ACTUALLY PINS THE VERSION CHECK, added after discovering the
  // one above does not. Two SIMULTANEOUS holds are already stopped by
  // `AND status = 'AVAILABLE'` on its own, because Postgres blocks the second
  // UPDATE on the row lock and then re-evaluates its WHERE against the
  // committed row. Deleting the version clause leaves that test green.
  //
  // What the version column is really for is the STALE read: a dispatcher
  // decided on this unit a while ago, and since then it has been held by
  // someone else and released. It is AVAILABLE again, so a status check alone
  // waves the stale claim through — but the plan behind it was computed
  // against a world that no longer exists.
  it('refuses a claim built on a version that has since moved, even if the unit is free again', async () => {
    const unitId = fixture.unitIds[4]!;
    await forceAvailable(unitId);
    const staleVersion = (await unitStatus(unitId)).version;

    // Somebody else holds it and gives it back. Status returns to AVAILABLE;
    // the version does not return to what the stale caller read.
    await prisma.unit.update({ where: { id: unitId }, data: { status: 'HELD', version: { increment: 1 } } });
    await prisma.unit.update({ where: { id: unitId }, data: { status: 'AVAILABLE', version: { increment: 1 } } });

    const result = await createHold(prisma, {
      unitId,
      jobId: fixture.jobIds[5]!,
      expectedVersion: staleVersion,
    });

    expect(result.outcome).toBe('LOST_RACE');
    expect((await unitStatus(unitId)).status).toBe('AVAILABLE');
    expect(await prisma.unitHold.count({ where: { unitId, status: 'ACTIVE' } })).toBe(0);
  });
});

describe('2. a technician accepts as the offer expires', () => {
  it('resolves to exactly one outcome, never both', async () => {
    // Repeated, because a race that resolves correctly once may only have
    // resolved correctly because one side happened to be slower.
    for (let attempt = 0; attempt < 12; attempt++) {
      const jobId = fixture.jobIds[10 + attempt]!;
      // Already expired at creation, so the timeout path is genuinely live at
      // the same instant as the accept rather than a second behind it.
      const { offerId } = await proposeOffer(prisma, {
        jobId,
        technicianId: fixture.technicianIds[0]!,
        ttlMs: -1_000,
        // No Redis. This test proves a Postgres race; the queue's own
        // behaviour is covered by tests/queues.test.ts, and requiring a broker
        // here would make the proof depend on infrastructure it is not about.
        scheduleExpiry: async () => {},
      });

      const [accept, expire] = await Promise.all([
        respondToOffer(prisma, { offerId, status: 'ACCEPTED' }),
        timeoutOffer(prisma, { offerId }),
      ]);

      const recorded = [accept, expire].filter((r) => r.outcome === 'RECORDED');
      expect(recorded, `attempt ${attempt}`).toHaveLength(1);

      // The row itself agrees with whichever call claimed to have won.
      const stored = await prisma.technicianOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { status: true },
      });
      expect(stored.status, `attempt ${attempt}`).toBe(recorded[0]!.status);
      expect(['ACCEPTED', 'TIMEOUT']).toContain(stored.status);
    }
  }, 60_000);
});

describe('3. release called twice', () => {
  it('frees the unit once and treats the second call as a no-op', async () => {
    const unitId = fixture.unitIds[1]!;
    await forceAvailable(unitId);
    const { version } = await unitStatus(unitId);

    const held = await createHold(prisma, {
      unitId,
      jobId: fixture.jobIds[2]!,
      expectedVersion: version,
    });
    if (held.outcome !== 'HELD') throw new Error('setup failed to take the hold');

    const [a, b] = await Promise.all([
      releaseHold(prisma, { holdId: held.holdId, reason: 'DISPATCHER_CANCELLED' }),
      releaseHold(prisma, { holdId: held.holdId, reason: 'DISPATCHER_CANCELLED' }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['ALREADY_RESOLVED', 'RELEASED']);

    // Neither call threw — invariant 6, every compensation is idempotent.
    expect((await unitStatus(unitId)).status).toBe('AVAILABLE');

    // AND NOT DOUBLE-FREED. The unit's version moved exactly twice: once to
    // take it, once to give it back. A second free would show up here as a
    // third increment even though the status looks identical.
    expect((await unitStatus(unitId)).version).toBe(version + 2);

    const events = await prisma.jobEvent.count({
      where: { jobId: fixture.jobIds[2]!, eventType: 'UNIT_HOLD_RELEASED' },
    });
    expect(events).toBe(1);
  });
});

describe('4. the hold expires mid-commit', () => {
  it('fails the commit cleanly instead of consuming an expired claim', async () => {
    const unitId = fixture.unitIds[2]!;
    await forceAvailable(unitId);
    const { version } = await unitStatus(unitId);

    const held = await createHold(prisma, {
      unitId,
      jobId: fixture.jobIds[3]!,
      expectedVersion: version,
      ttlMs: DEFAULT_HOLD_TTL_MS,
    });
    if (held.outcome !== 'HELD') throw new Error('setup failed to take the hold');

    // The sweep gets there first — exactly what the cleanup worker does.
    await prisma.unitHold.update({
      where: { id: held.holdId },
      data: { status: 'EXPIRED', releasedAt: new Date(), releaseReason: 'EXPIRED_BY_SWEEP' },
    });

    const result = await consumeHold(prisma, { holdId: held.holdId });

    expect(result.outcome).toBe('HOLD_NOT_ACTIVE');
    // Clean failure: the unit was NOT moved to ON_JOB behind the expired hold.
    expect((await unitStatus(unitId)).status).toBe('HELD');
  });

  it('refuses a hold that is still ACTIVE but past its expiry', async () => {
    const unitId = fixture.unitIds[3]!;
    await forceAvailable(unitId);
    const { version } = await unitStatus(unitId);

    // Born expired: ACTIVE, but its window has already closed. This is the
    // state the sweep has not reached yet, and it must not be consumable.
    const held = await createHold(prisma, {
      unitId,
      jobId: fixture.jobIds[4]!,
      expectedVersion: version,
      ttlMs: -1_000,
    });
    if (held.outcome !== 'HELD') throw new Error('setup failed to take the hold');

    const result = await consumeHold(prisma, { holdId: held.holdId });
    expect(result.outcome).toBe('HOLD_NOT_ACTIVE');
    if (result.outcome !== 'HOLD_NOT_ACTIVE') throw new Error('unreachable');
    expect(result.status).toBe('EXPIRED');
    expect((await unitStatus(unitId)).status).toBe('HELD');
  });
});

describe('5. fifty concurrent holds on ten units', () => {
  it('grants exactly ten', async () => {
    for (const unitId of fixture.unitIds) await forceAvailable(unitId);

    const versions = new Map<string, number>();
    for (const unitId of fixture.unitIds) {
      versions.set(unitId, (await unitStatus(unitId)).version);
    }

    // Fifty attempts spread over ten units: five contenders per unit, all
    // reading the same version, all firing at once.
    const attempts = Array.from({ length: 50 }, (_, index) => {
      const unitId = fixture.unitIds[index % fixture.unitIds.length]!;
      return createHold(prisma, {
        unitId,
        jobId: fixture.jobIds[20 + index]!,
        expectedVersion: versions.get(unitId)!,
      });
    });

    const results = await Promise.all(attempts);
    const won = results.filter((result) => result.outcome === 'HELD');

    expect(won).toHaveLength(10);
    expect(results.filter((result) => result.outcome === 'LOST_RACE')).toHaveLength(40);

    // One ACTIVE hold per unit, and every unit actually held.
    const active = await prisma.unitHold.groupBy({
      by: ['unitId'],
      where: { status: 'ACTIVE', unitId: { in: fixture.unitIds } },
      _count: true,
    });
    expect(active).toHaveLength(10);
    for (const row of active) expect(row._count, row.unitId).toBe(1);

    const statuses = await prisma.unit.findMany({
      where: { id: { in: fixture.unitIds } },
      select: { status: true },
    });
    expect(statuses.every((unit) => unit.status === 'HELD')).toBe(true);
  }, 60_000);
});
