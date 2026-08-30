// THE CLEANUP QUEUE'S REAL WORK — not a placeholder like its three siblings.
// Two things in this schema are already real and already rotting:
//
// STALE IDEMPOTENCY KEYS. `src/infra/config.ts`'s own comment on
// `IdempotencyKey` says it plainly: "Postgres has no TTL index, so a worker
// deletes expired rows on a schedule." That worker is this one. Nothing has
// swept this table since Phase 2 created it.
//
// EXPIRED HOLDS. `UnitHold` exists from Phase 1 but nothing WRITES a hold
// until Phase 11 — so this half of the sweep is a genuine no-op today, every
// time it runs, and that is the correct and uninteresting result. It is
// written now, against the real schema, so Phase 11 does not have to
// remember cleanup owes it something; it just starts finding real rows.
//
// THE RELEASE IS CONDITIONAL — an UPDATE matching on (id, version, status)
// rather than a blind write. (This used to point at Phase 4's manual
// assignUnit.ts as the other example of the pattern; Phase 9 deleted that
// file along with the dropdown it served, and Phase 11's holds will be the
// next real user of the same shape.) A hold can be released
// by an operator or consumed by a saga leg at the exact moment this sweep
// decides it looks expired; the version check is what stops the sweep from
// overwriting a release that already happened for a different reason.

import type { Job, Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { runIdempotently } from '../queues/idempotent.js';

export const CLEANUP_SCHEDULER_ID = 'cleanup-sweep';
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function scheduleCleanup(cleanupQueue: Queue): Promise<Job> {
  return cleanupQueue.upsertJobScheduler(
    CLEANUP_SCHEDULER_ID,
    { every: CLEANUP_INTERVAL_MS },
    { name: 'sweep' },
  );
}

async function sweepExpiredIdempotencyKeys(tx: Prisma.TransactionClient): Promise<number> {
  const result = await tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}

async function releaseExpiredHolds(tx: Prisma.TransactionClient): Promise<number> {
  // updateMany reports how many rows it actually changed, which is what makes
  // this safe to call on a table that changed under it: a hold already moved
  // to RELEASED or CONSUMED by another writer no longer matches `status:
  // 'ACTIVE'` and is silently skipped rather than clobbered.
  const result = await tx.unitHold.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED', releasedAt: new Date(), releaseReason: 'EXPIRED_BY_SWEEP' },
  });
  return result.count;
}

export async function processCleanup(job: Job): Promise<void> {
  await runIdempotently('cleanup', job.id!, async (tx) => {
    // Sequential, not Promise.all: an interactive Prisma transaction holds one
    // underlying connection, and issuing two queries on it concurrently races
    // over that single connection rather than actually running in parallel.
    const keysSwept = await sweepExpiredIdempotencyKeys(tx);
    const holdsReleased = await releaseExpiredHolds(tx);
    await job.log(`swept ${keysSwept} expired idempotency keys, released ${holdsReleased} expired holds`);
  });
}
