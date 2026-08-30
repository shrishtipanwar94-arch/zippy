import { config } from './infra/config.js';
import { logger } from './infra/logger.js';
import { prisma } from './infra/db.js';
import { sharedQueueConnection } from './queues/connection.js';
import { startWorkers, stopWorkers } from './workers/runWorkers.js';

/**
 * The worker process. It exists from Phase 0 — as its own process, not a
 * thread or a timer inside the web server — because background work deploys
 * and fails independently of request handling.
 *
 * From Phase 5: four BullMQ Workers (solver, offer-expiry, notification,
 * cleanup), each idempotent, each backed off with a cap, each dead-lettering
 * on exhaustion. `startWorkers()` in src/workers/runWorkers.ts owns their
 * construction; this file only owns the process lifecycle around them.
 */
logger.info({ env: config.NODE_ENV }, 'worker process starting');

await startWorkers();
logger.info('worker process started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker process shutting down');
  await stopWorkers().catch((error: unknown) => {
    logger.error({ err: error }, 'error while stopping workers');
  });
  await prisma.$disconnect().catch(() => undefined);
  sharedQueueConnection.disconnect();
  process.exit(0);
}

// If a job will not finish in time, exit anyway rather than hang a deploy —
// the same backstop src/index.ts uses for the web process.
process.on('SIGINT', () => {
  void shutdown('SIGINT');
  setTimeout(() => process.exit(1), 10_000).unref();
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
  setTimeout(() => process.exit(1), 10_000).unref();
});
