import { config } from './infra/config.js';
import { logger } from './infra/logger.js';

/**
 * The worker process. It exists from Phase 0 — as its own process, not a thread
 * or a timer inside the web server — because background work deploys and fails
 * independently of request handling.
 *
 * There is nothing to process yet. BullMQ queues and their processors arrive in
 * Phase 5. Until then this is a heartbeat: it validates the environment on
 * start (importing config would exit the process if a variable were missing),
 * stays alive, and shuts down cleanly on a signal.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

logger.info({ env: config.NODE_ENV }, 'worker process started');

const heartbeat = setInterval(() => {
  logger.debug('worker heartbeat — no queues wired yet');
}, HEARTBEAT_INTERVAL_MS);

function shutdown(signal: string): void {
  logger.info({ signal }, 'worker process shutting down');
  clearInterval(heartbeat);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
