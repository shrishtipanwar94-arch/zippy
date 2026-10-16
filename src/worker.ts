import { config } from './infra/config.js';
import { logger } from './infra/logger.js';
import { prisma } from './infra/db.js';
import { prismaBase } from './infra/prismaBase.js';
import { sharedQueueConnection } from './queues/connection.js';
import { startWorkers, stopWorkers } from './workers/runWorkers.js';
import { recoverSagas } from './commit/sagaRecovery.js';
import { startHealthLoop, stopHealthLoop } from './health/loop.js';
import { installConfiguredPaymentProvider } from './payments/selectProvider.js';
import { runDemoRefresh } from './workers/demoRefresh.js';
import { waitForMigrations } from './infra/waitForMigrations.js';

/**
 * The worker process. It exists from Phase 0 — as its own process, not a
 * thread or a timer inside the web server — because background work deploys
 * and fails independently of request handling.
 *
 * From Phase 5: four BullMQ Workers (solver, offer-expiry, notification,
 * cleanup), each idempotent, each backed off with a cap, each dead-lettering
 * on exhaustion. `startWorkers()` in src/workers/runWorkers.ts owns their
 * construction; this file only owns the process lifecycle around them.
 *
 * From Phase 17: the health-check loop runs here too — a bare timer rather
 * than a queued job, because the queue runs on Redis and Redis being down is
 * one of the states the loop exists to report.
 *
 * From Phase 12: saga recovery runs BEFORE the workers start. A process that
 * died mid-reservation left a unit held and a technician holding an offer for
 * it, and neither resolves on its own — so the first thing a restarted worker
 * does is finish or compensate whatever it finds, before any new work can
 * start competing for the same units.
 */
logger.info({ env: config.NODE_ENV }, 'worker process starting');

// BOTH PROCESSES INSTALL THE SAME PROVIDER. The retry sweep and the
// reconciliation worker call a gateway from here, exactly as the routes do from
// the web process, and a provider installed in only one of them would have the
// two disagreeing about where money lives.
installConfiguredPaymentProvider();

// FIRST, BEFORE ANY QUERY: the web process may still be migrating. See
// src/infra/waitForMigrations.ts for the crash this prevents. Throwing here
// exits the process non-zero, and the platform restarts it.
await waitForMigrations(prismaBase);

// Unscoped on purpose: recovery is a fleet-wide sweep with no requesting
// user, so there is no tenant to scope it to.
const recovered = await recoverSagas(prismaBase);
if (recovered.length > 0) {
  logger.warn({ recovered }, 'recovered sagas stranded by a previous process');
}

// THE DEMO BOARD, ONCE NOW AND THEN EVERY FIFTEEN MINUTES (DEMO_MODE only).
// Run directly here rather than waiting for the scheduler's first tick, so a
// worker that restarts after a long outage puts the crews back on shift before
// anybody can open the board. A failure is logged, not fatal: the real queues
// matter more than the demo fixture, and the next tick will try again.
if (config.demoMode) {
  try {
    logger.info(await runDemoRefresh());
  } catch (error) {
    logger.error({ err: error }, 'demo refresh on boot failed; the scheduled refresh will retry');
  }
}

await startWorkers();
startHealthLoop(prismaBase);
logger.info('worker process started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker process shutting down');
  stopHealthLoop();
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
