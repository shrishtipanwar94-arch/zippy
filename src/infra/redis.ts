import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { REDIS_ADDRESS_FAMILY } from './redisAddressFamily.js';

/**
 * The single Redis connection for the process. Redis is cache and queues only —
 * it never holds a reservation (invariant 1). BullMQ (Phase 5) will add its own
 * connections with different options; this one is for lightweight commands like
 * the /health PING.
 *
 * When Redis is unreachable ioredis keeps retrying in the background and
 * individual commands reject quickly (maxRetriesPerRequest: 1). The process
 * must stay alive through a Redis outage, so the 'error' listener below just
 * logs — an unhandled 'error' event on an EventEmitter would crash the process.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    family: REDIS_ADDRESS_FAMILY,
    retryStrategy: (attempt: number) => Math.min(attempt * 500, 5000),
  });

redis.on('error', (error: Error) => {
  logger.error({ err: error }, 'redis connection error');
});

if (!config.isProduction) {
  globalForRedis.redis = redis;
}
