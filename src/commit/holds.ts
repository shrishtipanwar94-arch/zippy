// UNIT HOLDS — the first place two dispatchers can genuinely collide.
//
// OPTIMISTIC LOCKING, and why it is not a row lock. Two dispatchers can pick
// the same unit in the same second. The obvious fix is `SELECT … FOR UPDATE`,
// which holds a row lock until the transaction commits — but the transaction
// that follows a dispatch decision waits on a technician's phone, and holding
// a Postgres lock open across a human being is how a connection pool dies.
// So instead of locking the row, we update it CONDITIONALLY on the version we
// read. If someone else got there first the version has moved, zero rows are
// affected, and we know we lost — without ever having held a lock.
//
// The check and the claim are ONE statement. That is the entire trick: there
// is no window between "is it available?" and "take it", because Postgres
// evaluates the WHERE and applies the UPDATE atomically. A read followed by a
// write would have exactly the window this avoids.
//
// WHY RAW SQL HERE. `updateMany` could express the same conditional update,
// and this is the one place worth writing out longhand: the WHERE clause IS
// the concurrency argument, and an interviewer asking "where is the race
// handled?" should be able to read the answer as one statement rather than
// reconstruct it from an ORM call. Values are bound as parameters by Prisma's
// tagged template — never interpolated into the string.
//
// A HOLD IS NOT AN ASSIGNMENT. It is a short-lived claim that stops anyone
// else taking the unit while an offer is out to a technician. It expires on
// its own (the cleanup sweep releases it), and it is consumed by the Phase 12
// saga when the reservation actually completes.

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

// How long a hold survives without being consumed or released. Long enough
// for a technician to answer their phone, short enough that a unit is not
// stranded by a dispatcher who closed their laptop. Not a measured figure.
export const DEFAULT_HOLD_TTL_MS = 2 * 60 * 1000;

export type HoldOutcome =
  | { outcome: 'HELD'; holdId: string }
  // Someone else changed the unit between the caller reading it and this
  // update running. The caller re-reads and re-plans; it is a normal outcome
  // on a busy board, not an error.
  | { outcome: 'LOST_RACE'; detail: string };

export type CreateHoldInput = {
  unitId: string;
  jobId: string;
  // The version the caller saw when it decided on this unit. The whole point:
  // if the row has moved on since, this claim is stale.
  expectedVersion: number;
  ttlMs?: number;
  actor?: { role: string; id: string | null };
};

export async function createHold(
  db: PrismaClient,
  input: CreateHoldInput,
): Promise<HoldOutcome> {
  const ttlMs = input.ttlMs ?? DEFAULT_HOLD_TTL_MS;

  return runPublishingTransaction(db, async (tx) => {
    // THE CONDITIONAL UPDATE. Zero rows affected means we lost the race.
    const claimed = await tx.$executeRaw`
      UPDATE units
         SET status = 'HELD', version = version + 1, updated_at = now()
       WHERE id = ${input.unitId}
         AND status = 'AVAILABLE'
         AND version = ${input.expectedVersion}
    `;

    if (claimed === 0) {
      // Re-read purely to say WHY, and only on the losing path so the winning
      // path costs nothing. The unit may be held, on a job, offline, or simply
      // a version ahead of what the caller saw.
      const unit = await tx.unit.findUnique({
        where: { id: input.unitId },
        select: { status: true, version: true },
      });
      const detail = unit
        ? `unit is ${unit.status} at version ${unit.version}, caller expected AVAILABLE at ${input.expectedVersion}`
        : 'unit does not exist';
      return { outcome: 'LOST_RACE', detail } as const;
    }

    const hold = await tx.unitHold.create({
      data: {
        unitId: input.unitId,
        jobId: input.jobId,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + ttlMs),
      },
      select: { id: true },
    });

    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'UNIT_HELD',
      payload: { unitId: input.unitId, holdId: hold.id },
      actorRole: input.actor?.role ?? null,
      actorId: input.actor?.id ?? null,
    });

    return { outcome: 'HELD', holdId: hold.id } as const;
  });
}

// ---------------------------------------------------------------------------
// RELEASING, AND WHY DOUBLE-RELEASE IS A NO-OP RATHER THAN AN ERROR.
//
// Three different things release a hold: a dispatcher changing their mind, the
// cleanup sweep finding it expired, and the Phase 12 saga compensating a leg
// that failed. They can overlap. A saga compensation that threw because the
// sweep got there first would turn a tidy outcome into a failed compensation,
// and invariant 6 says every compensation is idempotent — so releasing twice
// has to be boring.
//
// It also must not DOUBLE-FREE. The unit is only returned to AVAILABLE by the
// call that actually moved the hold out of ACTIVE. A second call finds the
// hold already released, changes nothing, and leaves the unit alone — which
// matters because by then the unit may legitimately have been taken by
// somebody else, and blindly setting it AVAILABLE would hand out a unit that
// is already on a job.

export type ReleaseOutcome =
  | { outcome: 'RELEASED' }
  | { outcome: 'ALREADY_RESOLVED'; status: string };

export type ReleaseHoldInput = {
  holdId: string;
  reason: string;
  actor?: { role: string; id: string | null };
};

export async function releaseHold(
  db: PrismaClient,
  input: ReleaseHoldInput,
): Promise<ReleaseOutcome> {
  return runPublishingTransaction(db, async (tx) => {
    const hold = await tx.unitHold.findUnique({
      where: { id: input.holdId },
      select: { id: true, unitId: true, jobId: true, status: true, version: true },
    });
    if (!hold) return { outcome: 'ALREADY_RESOLVED', status: 'MISSING' } as const;

    // Conditional on the hold still being ACTIVE at the version we just read.
    // Two concurrent releases both pass the read; exactly one changes a row.
    const released = await tx.$executeRaw`
      UPDATE unit_holds
         SET status = 'RELEASED', released_at = now(), release_reason = ${input.reason}, version = version + 1
       WHERE id = ${input.holdId}
         AND status = 'ACTIVE'
         AND version = ${hold.version}
    `;

    if (released === 0) {
      const current = await tx.unitHold.findUnique({
        where: { id: input.holdId },
        select: { status: true },
      });
      return { outcome: 'ALREADY_RESOLVED', status: current?.status ?? 'MISSING' } as const;
    }

    // Only the winner frees the unit, and only if it is still the one this
    // hold is holding. `AND status = 'HELD'` is what stops a late release
    // from freeing a unit that has since been legitimately dispatched.
    await tx.$executeRaw`
      UPDATE units
         SET status = 'AVAILABLE', version = version + 1, updated_at = now()
       WHERE id = ${hold.unitId}
         AND status = 'HELD'
    `;

    await appendJobEvent(tx, {
      jobId: hold.jobId,
      eventType: 'UNIT_HOLD_RELEASED',
      payload: { unitId: hold.unitId, holdId: hold.id, reason: input.reason },
      actorRole: input.actor?.role ?? null,
      actorId: input.actor?.id ?? null,
    });

    return { outcome: 'RELEASED' } as const;
  });
}

// ---------------------------------------------------------------------------
// CONSUMING a hold — the Phase 12 saga's success path, written here because it
// is the same conditional-update shape and belongs next to its siblings.
//
// A hold that expired a millisecond ago must NOT be consumable: that is the
// "hold expires mid-commit" case, and it has to fail cleanly rather than
// quietly commit against a claim the system already gave up. The expiry check
// is inside the same WHERE clause for the same reason the status check is —
// checking it separately would reintroduce the window.

export type ConsumeOutcome =
  | { outcome: 'CONSUMED' }
  | { outcome: 'HOLD_NOT_ACTIVE'; status: string };

export async function consumeHold(
  db: PrismaClient,
  input: { holdId: string; at?: Date },
): Promise<ConsumeOutcome> {
  const at = input.at ?? new Date();

  return runPublishingTransaction(db, async (tx) => {
    const consumed = await tx.$executeRaw`
      UPDATE unit_holds
         SET status = 'CONSUMED', version = version + 1
       WHERE id = ${input.holdId}
         AND status = 'ACTIVE'
         AND expires_at > ${at}
    `;

    if (consumed === 0) {
      const current = await tx.unitHold.findUnique({
        where: { id: input.holdId },
        select: { status: true, expiresAt: true },
      });
      if (!current) return { outcome: 'HOLD_NOT_ACTIVE', status: 'MISSING' } as const;
      // An ACTIVE row that failed the update failed on the expiry clause. Say
      // so, rather than reporting the stale status and leaving the caller to
      // work out why an ACTIVE hold could not be consumed.
      const status = current.status === 'ACTIVE' && current.expiresAt <= at ? 'EXPIRED' : current.status;
      return { outcome: 'HOLD_NOT_ACTIVE', status } as const;
    }

    // The unit moves from HELD to ON_JOB in the same transaction. If this
    // failed the hold would be consumed against a unit nobody dispatched.
    const moved = await tx.$executeRaw`
      UPDATE units
         SET status = 'ON_JOB', version = version + 1, updated_at = now()
       WHERE id = (SELECT unit_id FROM unit_holds WHERE id = ${input.holdId})
         AND status = 'HELD'
    `;
    if (moved === 0) {
      // The hold was consumable but the unit was not HELD — the two disagree,
      // which should be impossible. Roll back rather than leave them
      // inconsistent.
      throw new Prisma.PrismaClientKnownRequestError(
        'hold consumed but its unit was not HELD',
        { code: 'P2025', clientVersion: Prisma.prismaVersion.client },
      );
    }

    return { outcome: 'CONSUMED' } as const;
  });
}
