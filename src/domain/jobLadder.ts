// THE TECHNICIAN'S STATUS LADDER — five steps, one direction.
//
// A technician progresses a job by climbing a fixed ladder: on the way, on
// scene, working out what is wrong, fixing it, done. Each rung maps to one
// JobStatus, and the whole point of modelling it as a RANKED list rather than
// a set of allowed pairs is Phase 15's offline queue.
//
// MONOTONIC ADVANCE — the concept this file exists for.
// A phone that lost signal replays four actions when it reconnects. Two things
// can go wrong: the same action arrives twice, or one of them was lost and the
// later ones arrive without it. Ranking every step and only ever moving the
// job FORWARD handles both without any special case. A replay targets a rank
// the job has already passed and changes nothing; a gap is closed by the next
// step that does arrive, because moving to a higher rank is legal from any
// lower one. There is no "expected predecessor" to get wrong.
//
// PURE. No database, no clock. What this decides is checked again by a
// conditional UPDATE at the point of writing (src/commit/technicianActions.ts)
// — this file says what SHOULD happen, that statement is what makes it safe
// when two writers arrive at once.

import type { JobStatus } from '@prisma/client';

export const LADDER_STEPS = ['EN_ROUTE', 'ARRIVED', 'DIAGNOSING', 'WORKING', 'COMPLETE'] as const;

export type LadderStep = (typeof LADDER_STEPS)[number];

export function isLadderStep(value: string): value is LadderStep {
  return (LADDER_STEPS as readonly string[]).includes(value);
}

// The status each rung puts the job in. Two names differ from the step on
// purpose: ARRIVED means the job is ON_SITE, and COMPLETE means it is RESOLVED
// — the ladder is the technician's vocabulary, the enum is the domain's.
const STATUS_FOR_STEP: Record<LadderStep, JobStatus> = {
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ON_SITE',
  DIAGNOSING: 'DIAGNOSING',
  WORKING: 'WORKING',
  COMPLETE: 'RESOLVED',
};

// How far up the ladder each status is. COMMITTED is rank 0 — a crew is
// assigned and has not started moving. Every status NOT in this table is off
// the ladder entirely (cancelled, awaiting a workshop, still being planned),
// and a ladder action against one of those is refused rather than guessed at.
const RANK_FOR_STATUS: Partial<Record<JobStatus, number>> = {
  COMMITTED: 0,
  EN_ROUTE: 1,
  ON_SITE: 2,
  DIAGNOSING: 3,
  WORKING: 4,
  RESOLVED: 5,
};

export function statusForStep(step: LadderStep): JobStatus {
  return STATUS_FOR_STEP[step];
}

// The step a technician should be offered next, given where the job is. Null
// once the job is finished or has left the ladder.
export function nextStepFor(status: JobStatus): LadderStep | null {
  const rank = RANK_FOR_STATUS[status];
  if (rank === undefined) return null;
  return LADDER_STEPS[rank] ?? null;
}

export type LadderMove =
  | { outcome: 'ADVANCE'; to: JobStatus; from: JobStatus[] }
  // The job is already at or past this rung. A replayed action, and a normal
  // one — not an error, and the caller must not turn it into one.
  | { outcome: 'ALREADY_PAST' }
  // The job is not on the ladder at all: cancelled, unserviceable, still being
  // planned. Nothing to advance.
  | { outcome: 'OFF_LADDER' };

export function ladderMove(current: JobStatus, step: LadderStep): LadderMove {
  const currentRank = RANK_FOR_STATUS[current];
  if (currentRank === undefined) return { outcome: 'OFF_LADDER' };

  const targetRank = LADDER_STEPS.indexOf(step) + 1;
  if (targetRank <= currentRank) return { outcome: 'ALREADY_PAST' };

  // Every status strictly below the target is a legal starting point, and the
  // list is handed to the caller so its UPDATE can name them in a WHERE clause.
  // That is what makes the write conditional rather than a read-then-write.
  const from = statusesBelow(targetRank);
  return { outcome: 'ADVANCE', to: STATUS_FOR_STEP[step], from };
}

function statusesBelow(rank: number): JobStatus[] {
  const below: JobStatus[] = [];
  for (const [status, statusRank] of Object.entries(RANK_FOR_STATUS)) {
    if (statusRank !== undefined && statusRank < rank) below.push(status as JobStatus);
  }
  return below;
}
