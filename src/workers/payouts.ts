// THE DAILY PAYOUT JOB.
//
// Scheduled on the CLEANUP QUEUE rather than a fifth queue of its own, and the
// reason is that the cleanup queue is already the periodic-work queue: it
// carries a five-minute sweep and now a daily payout run, and both are "a
// thing that happens on a timer with nobody waiting on the answer". Adding a
// queue would mean a fifth Worker, a fifth Redis connection and a fifth entry
// in every wiring table, to run one job a day.
//
// The two are told apart by job NAME, and `runWorkers.ts` routes on it.
//
// EVERY DAY AT THE SAME TIME, and the reference the run computes is a DATE —
// so the schedule firing twice, a worker restarting mid-run, or an operator
// triggering it by hand all land on the same batch rather than paying anybody
// twice. BullMQ's scheduler already guarantees at-least-once, not
// exactly-once, which is exactly why the idempotency lives in the batch
// reference rather than in the scheduler.

import type { Job, Queue } from 'bullmq';
import { prismaBase } from '../infra/prismaBase.js';
import { runPayoutBatch } from '../commit/payouts.js';

export const PAYOUT_SCHEDULER_ID = 'payout-daily';
export const PAYOUT_JOB_NAME = 'payouts';
const DAY_MS = 24 * 60 * 60 * 1000;

export function schedulePayoutRun(cleanupQueue: Queue): Promise<Job> {
  return cleanupQueue.upsertJobScheduler(
    PAYOUT_SCHEDULER_ID,
    { every: DAY_MS },
    { name: PAYOUT_JOB_NAME },
  );
}

export async function processPayoutRun(job: Job): Promise<void> {
  // NOT wrapped in `runIdempotently`. That helper claims a key and runs the
  // effect in ONE transaction, and this run posts a ledger transaction per
  // technician — each of which must commit on its own for the deferred balance
  // trigger to check it. The idempotency is the batch reference instead, which
  // is stronger here: it survives a crash mid-run and lets the next attempt
  // resume rather than skip.
  const result = await runPayoutBatch(prismaBase);

  await job.log(
    `batch ${result.reference}: paid ${result.paid}, held ${result.heldBelowMinimum} below the ` +
      `minimum, ${result.carryingDebt} carrying debt, ${result.totalPaise} paise pending transfer`,
  );
}
