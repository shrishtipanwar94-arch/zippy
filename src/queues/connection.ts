// TWO DIFFERENT REDIS CONFIGURATIONS FOR TWO DIFFERENT JOBS.
//
// `src/infra/redis.ts` is tuned for the `/health` PING: fail fast
// (`maxRetriesPerRequest: 1`) so a slow Redis cannot make a request hang.
// BullMQ is the opposite. It holds long-lived blocking connections waiting for
// the next job (`BLMOVE` under the hood) and REQUIRES
// `maxRetriesPerRequest: null` — with a finite value ioredis gives up on the
// blocking command itself and BullMQ's internal retry logic breaks in ways
// that are hard to diagnose. Reusing the health-check connection for BullMQ
// would either make `/health` block for the queue's sake or make the queue
// unreliable for `/health`'s sake. Two connections, two purposes.
//
// ONE CONNECTION PER WORKER, A SHARED ONE FOR QUEUES.
// A `Worker` spends most of its life blocked waiting for the next job, so
// giving two Workers the same connection would have one blocking the other's
// ability to even issue commands. A `Queue` (used to `add()` jobs and by Bull
// Board to read state) only ever issues quick, non-blocking commands, so many
// `Queue` instances safely share one connection — that is what
// `sharedQueueConnection` is for.

import { Redis } from 'ioredis';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { REDIS_ADDRESS_FAMILY } from '../infra/redisAddressFamily.js';

function createBullConnection(label: string): Redis {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    family: REDIS_ADDRESS_FAMILY,
  });

  connection.on('error', (error: Error) => {
    logger.error({ err: error, connection: label }, 'bullmq redis connection error');
  });

  return connection;
}

// Cached on globalThis in dev for the same reason src/infra/redis.ts is —
// `tsx watch` reloads this module on every save, and a fresh connection each
// time would leak sockets until Redis's connection limit is hit.
const globalForQueues = globalThis as unknown as { sharedQueueConnection?: Redis };

export const sharedQueueConnection: Redis =
  globalForQueues.sharedQueueConnection ?? createBullConnection('queues-shared');

if (!config.isProduction) {
  globalForQueues.sharedQueueConnection = sharedQueueConnection;
}

// Called once per Worker at construction. Not cached — each Worker owns its
// connection for its whole lifetime and closes it when the Worker closes.
export function createWorkerConnection(queueName: string): Redis {
  return createBullConnection(`worker:${queueName}`);
}
