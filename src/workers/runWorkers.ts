// Wires every queue name to its processor, with the shared retry budget,
// capped backoff, and dead-letter handling. `src/worker.ts` calls
// `startWorkers()` once at process start and `stopWorkers()` once on shutdown
// — nowhere else constructs a `Worker`.
//
// ONE WORKER PER QUEUE, EACH ON ITS OWN CONNECTION. See connection.ts for why
// a Worker cannot share a connection the way a Queue can.

import { Worker } from 'bullmq';
import type { Job, Processor } from 'bullmq';
import { createWorkerConnection } from '../queues/connection.js';
import { cappedExponentialBackoff } from '../queues/backoff.js';
import { moveToDeadLetterIfTerminal } from '../queues/deadLetter.js';
import { queues } from '../queues/queues.js';
import { QUEUE_NAMES } from '../queues/names.js';
import type { QueueName } from '../queues/names.js';
import { logger } from '../infra/logger.js';
import { processSolver } from './solver.js';
import { processNotification } from './notification.js';
import { processOfferExpiry } from './offerExpiry.js';
import { processCleanup, scheduleCleanup } from './cleanup.js';
import { PAYOUT_JOB_NAME, processPayoutRun, schedulePayoutRun } from './payouts.js';

// Keyed by QUEUE_NAMES rather than iterated with Object.entries: TypeScript
// widens an object literal's keys back to plain `string` when you call
// Object.entries on it, and iterating the typed QueueName tuple instead keeps
// `name` a QueueName everywhere below with no cast to get there.
//
// Typed as BullMQ's own `Processor`, not something narrower: each function
// below keeps its real, specific `Job<{ zoneId: string }>`-style parameter
// where it is actually defined and called directly (in solver.ts etc — that
// is where the real type checking happens), but a table holding FOUR
// differently-shaped processors has no single shape of its own to be precise
// about. `Processor` is BullMQ's public boundary type for exactly this job.
// THE CLEANUP QUEUE CARRIES TWO KINDS OF PERIODIC WORK, told apart by job
// name: a five-minute sweep and a daily payout run. One queue rather than two
// because both are "a thing on a timer with nobody waiting on the answer", and
// a second queue would mean a second Worker, a second Redis connection and a
// second entry in every wiring table to run one job a day.
async function processPeriodic(job: Job): Promise<void> {
  if (job.name === PAYOUT_JOB_NAME) {
    await processPayoutRun(job);
    return;
  }
  await processCleanup(job);
}

const PROCESSORS: Record<QueueName, Processor> = {
  solver: processSolver,
  'offer-expiry': processOfferExpiry,
  notification: processNotification,
  cleanup: processPeriodic,
};

let workers: Worker[] = [];

export async function startWorkers(): Promise<void> {
  workers = QUEUE_NAMES.map((name) => {
    const worker = new Worker(name, PROCESSORS[name], {
      connection: createWorkerConnection(name),
      settings: { backoffStrategy: cappedExponentialBackoff },
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      void moveToDeadLetterIfTerminal(name, job, error);
    });
    worker.on('error', (error: Error) => {
      logger.error({ queue: name, err: error }, 'worker connection error');
    });

    return worker;
  });

  await scheduleCleanup(queues.cleanup);
  await schedulePayoutRun(queues.cleanup);
  logger.info({ queues: QUEUE_NAMES }, 'workers started');
}

export async function stopWorkers(): Promise<void> {
  // `worker.close()` waits for the job it is currently running to finish
  // (or requeues it if none is running) before releasing its connection —
  // this is what "in-flight jobs finish or requeue, none lost" means in
  // practice. No force flag: a hard process-exit timeout in worker.ts is the
  // backstop if a job will not finish in time, not this call.
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
}
