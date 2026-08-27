import { Router } from 'express';
import { prisma } from '../infra/db.js';
import { redis } from '../infra/redis.js';

/**
 * GET /health actually checks the dependencies it claims to check: a real
 * `SELECT 1` against Postgres and a real PING against Redis. It never returns a
 * hardcoded 200 — the status code is derived from the probe results, so a
 * dependency being down produces a 503 while the process itself stays alive and
 * keeps answering. A load balancer or an operator can tell the difference
 * between "process gone" and "process up, database gone".
 */
export const healthRouter = Router();

const processStartedAt = Date.now();
const PROBE_TIMEOUT_MS = 1000;

// Resolves to false instead of rejecting, so one slow or failing probe cannot
// take down the handler or leak an unhandled rejection.
function probe(check: () => Promise<unknown>): Promise<boolean> {
  const attempt = check().then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  return Promise.race([attempt, timeout]);
}

async function checkDatabase(): Promise<boolean> {
  return probe(() => prisma.$queryRaw`SELECT 1`);
}

async function checkRedis(): Promise<boolean> {
  return probe(async () => {
    const reply = await redis.ping();
    if (reply !== 'PONG') {
      throw new Error(`unexpected PING reply: ${reply}`);
    }
  });
}

healthRouter.get('/health', async (_req, res) => {
  const [db, redisOk] = await Promise.all([checkDatabase(), checkRedis()]);
  const healthy = db && redisOk;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db,
    redis: redisOk,
    uptime: Math.floor((Date.now() - processStartedAt) / 1000),
  });
});
