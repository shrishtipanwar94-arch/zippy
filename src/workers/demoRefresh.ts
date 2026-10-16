// THE DEMO BOARD'S FIFTEEN-MINUTE REFRESH — only when DEMO_MODE=true.
//
// Keeps the four demo crews on shift and their stock counted (see
// src/demo/refreshDemoShifts.ts and src/demo/refreshDemoStock.ts for why each
// goes stale on its own). Scheduled on the CLEANUP QUEUE, the periodic-work
// queue, beside the sweep and the payout run, and told apart by job name.
//
// FIFTEEN MINUTES is comfortably inside both clocks it is racing: a shift has
// eight hours left after each refresh, and a stock count takes two hours to
// even start ageing. A missed tick or two costs nothing.
//
// A JOB SCHEDULER LIVES IN REDIS, NOT IN THIS PROCESS. Once upserted it keeps
// firing across restarts, so turning DEMO_MODE off has to REMOVE it — simply
// not scheduling it again would leave the old one running.

import type { Job, Queue } from 'bullmq';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { prismaBase } from '../infra/prismaBase.js';
import { refreshDemoShifts } from '../demo/refreshDemoShifts.js';
import { refreshDemoStock } from '../demo/refreshDemoStock.js';

export const DEMO_REFRESH_SCHEDULER_ID = 'demo-refresh';
export const DEMO_REFRESH_JOB_NAME = 'demo-refresh';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export async function scheduleDemoRefresh(cleanupQueue: Queue): Promise<void> {
  if (!config.demoMode) {
    await cleanupQueue.removeJobScheduler(DEMO_REFRESH_SCHEDULER_ID);
    return;
  }
  await cleanupQueue.upsertJobScheduler(
    DEMO_REFRESH_SCHEDULER_ID,
    { every: FIFTEEN_MINUTES_MS },
    { name: DEMO_REFRESH_JOB_NAME },
  );
}

// Called directly once on worker boot, and by the scheduled job after that.
export async function runDemoRefresh(): Promise<string> {
  const technicians = await refreshDemoShifts(prismaBase);
  const units = await refreshDemoStock(prismaBase);
  return `demo refresh: ${technicians.length} shifts reopened, ${units.length} vans re-counted`;
}

export async function processDemoRefresh(job: Job): Promise<void> {
  // A scheduler left behind in Redis from a run that had DEMO_MODE on must not
  // touch the database of one that has it off.
  if (!config.demoMode) {
    logger.warn('demo refresh fired with DEMO_MODE off; ignoring');
    return;
  }
  await job.log(await runDemoRefresh());
}
