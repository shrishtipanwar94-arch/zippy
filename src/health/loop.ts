// THE HEALTH-CHECK LOOP — the thing that makes the ladder move on its own.
//
// FIFTEEN SECONDS, and the number is a promise rather than a preference: the
// phase's own check is that every control "recovers on its own within a
// minute of switching back", so the loop has to run comfortably inside that
// with room for one missed tick. A control that leaves the system stuck is the
// worst possible demo failure, and a loop that ran every five minutes would
// produce exactly that.
//
// IT LIVES IN THE WORKER, NOT THE WEB PROCESS. Two web processes behind a load
// balancer would each run their own copy and write the same rows twice a
// second between them; the worker is already the single place periodic work
// happens (src/worker.ts).
//
// NOT A BullMQ JOB, and this is the one place in the codebase that deliberately
// uses a bare timer instead. The queue runs on Redis, Redis going down is one
// of the states this loop exists to REPORT, and a health check that stops
// running exactly when the system becomes unhealthy is worse than none: the
// console would keep showing the last green reading for ever.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { probeAll } from './probes.js';
import { recordComponentHealth } from './state.js';
import { systemMode } from '../domain/healthLadder.js';

export const HEALTH_CHECK_INTERVAL_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let lastMode: string | null = null;

export async function runHealthCheck(db: PrismaClient, now = new Date()): Promise<void> {
  const readings = await probeAll(db, now);

  for (const reading of readings) {
    await recordComponentHealth(
      db,
      reading.component,
      reading.state,
      reading.detail ?? 'nothing to report',
    );
  }

  // The system's own mode is logged separately from its components, because
  // "we are now CRITICAL" is the line somebody greps for, and it is not
  // deducible at a glance from six component rows.
  const mode = systemMode(readings);
  if (mode !== lastMode) {
    logger.warn({ from: lastMode, to: mode }, 'system health mode changed');
    lastMode = mode;
  }
}

export function startHealthLoop(db: PrismaClient): void {
  if (timer) return;

  // One immediate pass so a restarted worker does not leave a stale reading up
  // for the first fifteen seconds.
  void safeRun(db);
  timer = setInterval(() => void safeRun(db), HEALTH_CHECK_INTERVAL_MS);
  // Never hold the process open: a shutdown that is only waiting on the health
  // timer should just exit.
  timer.unref();
  logger.info({ intervalMs: HEALTH_CHECK_INTERVAL_MS }, 'health check loop started');
}

export function stopHealthLoop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// A failed probe run is logged and forgotten. The next tick is fifteen seconds
// away, and a loop that died because Postgres blinked would take the console's
// only source of truth with it.
async function safeRun(db: PrismaClient): Promise<void> {
  try {
    await runHealthCheck(db);
  } catch (error) {
    logger.error({ err: error }, 'health check failed');
  }
}
