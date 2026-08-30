// The five `Queue` objects: the four business queues plus the dead-letter
// destination. A `Queue` instance does not process anything by itself — it is
// how you `add()` work and how Bull Board reads state. Created once here and
// shared by both processes: the web process needs them for Bull Board and for
// any future `enqueue*` call site; the worker process needs them to build its
// `Worker`s against the same names and options.

import { Queue } from 'bullmq';
import { config } from '../infra/config.js';
import { sharedQueueConnection } from './connection.js';
import { RETRY_JOB_OPTIONS } from './backoff.js';
import { QUEUE_NAMES, DEAD_LETTER_QUEUE_NAME } from './names.js';
import type { QueueName } from './names.js';

const globalForQueues = globalThis as unknown as {
  queues?: Record<QueueName, Queue>;
  deadLetterQueue?: Queue;
};

// The shared retry budget lives on the QUEUE (via `defaultJobOptions`), set
// once here at construction — `Queue.defaultJobOptions` has no setter, so this
// is the only place it can be configured, not something runWorkers.ts can
// patch on afterwards.
function buildQueues(): Record<QueueName, Queue> {
  const entries = QUEUE_NAMES.map(
    (name) =>
      [
        name,
        new Queue(name, { connection: sharedQueueConnection, defaultJobOptions: RETRY_JOB_OPTIONS }),
      ] as const,
  );
  return Object.fromEntries(entries) as Record<QueueName, Queue>;
}

export const queues: Record<QueueName, Queue> = globalForQueues.queues ?? buildQueues();

export const deadLetterQueue: Queue =
  globalForQueues.deadLetterQueue ??
  new Queue(DEAD_LETTER_QUEUE_NAME, { connection: sharedQueueConnection });

if (!config.isProduction) {
  globalForQueues.queues = queues;
  globalForQueues.deadLetterQueue = deadLetterQueue;
}
