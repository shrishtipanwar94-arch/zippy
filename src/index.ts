import { createApp } from './api/app.js';
import { config } from './infra/config.js';
import { logger } from './infra/logger.js';
import { prisma } from './infra/db.js';
import { redis } from './infra/redis.js';
import { createRealtimeServer, closeRealtimeAdapter } from './realtime/server.js';
import { installConfiguredPaymentProvider } from './payments/selectProvider.js';

/**
 * The web process. Serves the HTTP API and Socket.IO (and, from later in
 * Phase 4, the static frontend). It is one of two always-on processes;
 * src/worker.ts is the other. They are started, deployed and scaled separately
 * because they fail differently.
 */
installConfiguredPaymentProvider();

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, publicUrl: config.PUBLIC_URL, env: config.NODE_ENV },
    'web process listening',
  );
});

// Socket.IO shares the HTTP server rather than binding its own port: one
// origin, one certificate, and no second thing to expose at deploy time.
const io = createRealtimeServer(server);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'web process shutting down');
  // Close sockets first: an open WebSocket keeps the HTTP server alive and
  // `server.close()` would wait for it until the deploy timeout below fired.
  await io.close().catch(() => undefined);
  await closeRealtimeAdapter().catch(() => undefined);
  server.close(async () => {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
    process.exit(0);
  });
  // If connections do not drain in time, exit anyway rather than hang a deploy.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
