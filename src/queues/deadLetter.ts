// DEAD-LETTER QUEUE FOR TERMINAL FAILURES.
//
// BullMQ has no built-in dead-letter queue — a job that exhausts its retries
// just sits in the queue's own "failed" set. That is enough to inspect one
// failure, but it mixes every queue's terminal failures into that queue's own
// history and gives an operator no single place to look. `moveToDeadLetter`
// is wired to every Worker's `failed` event (see runWorkers.ts) and, ONLY on
// the attempt that was the last one, copies the job's name, data and error
// into `dead-letter` — leaving the original failed job where it was, since
// BullMQ already keeps that as the detailed record.
//
// "Terminal" means `attemptsMade >= attempts`, not merely "failed" — most
// failures here are a scheduled retry, not a dead letter, and moving every
// one would defeat the point of retrying at all.

import type { Job } from 'bullmq';
import { deadLetterQueue } from './queues.js';
import { logger } from '../infra/logger.js';
import type { QueueName } from './names.js';

export async function moveToDeadLetterIfTerminal(
  queueName: QueueName,
  job: Job | undefined,
  error: Error,
): Promise<void> {
  if (!job) return;

  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;

  logger.error(
    { queue: queueName, jobId: job.id, attempts: job.attemptsMade, err: error },
    'job exhausted its retries — moving to dead-letter',
  );

  await deadLetterQueue.add(job.name, {
    originalQueue: queueName,
    originalJobId: job.id,
    data: job.data as unknown,
    attemptsMade: job.attemptsMade,
    failedReason: error.message,
    failedAt: new Date().toISOString(),
  });
}
