// Connections for the realtime layer's OWN use of Redis — separate from both
// `src/infra/redis.ts` (tuned to fail fast, for the health check) and
// `src/queues/connection.ts` (tuned for BullMQ's blocking job-fetch commands).
// Pub/sub is a third thing again: once a connection issues SUBSCRIBE it is
// locked into subscriber mode and cannot run anything else on it, so it must
// always be a connection of its own, never shared with a Queue or a Worker.

import { Redis } from 'ioredis';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';

export function createRealtimeRedisConnection(label: string): Redis {
  const connection = new Redis(config.REDIS_URL);

  connection.on('error', (error: Error) => {
    logger.error({ err: error, connection: label }, 'realtime redis connection error');
  });

  return connection;
}
