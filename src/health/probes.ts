// WHAT EACH COMPONENT'S STATE IS RIGHT NOW — six questions asked against the
// real world, plus the switch board.
//
// A FORCED FAILURE AND A REAL ONE PRODUCE THE SAME READING, deliberately. The
// probe reports what an operator would experience, and the `detail` says which
// it was ("forced by a chaos switch" vs the actual error), so the banner is
// honest about the system's behaviour and the log is honest about the cause.
// A demo where the forced failure took a different code path would be a demo
// of the demo, not of the system.
//
// EVERY PROBE ANSWERS, NEVER THROWS. A probe that threw would take down the
// health loop, which is the one thing that must keep running while everything
// else is on fire.

import type { PrismaClient } from '@prisma/client';
import { redis } from '../infra/redis.js';
import { isChaosOn } from '../chaos/switches.js';
import type { ComponentReading } from '../domain/healthLadder.js';
import { POSITION_STALE_AFTER_MS } from '../commit/unitPosition.js';

// How stale the newest position in the fleet may be before the map is lying.
// Units report on movement rather than on a timer, so this is generous: it is
// "nothing at all has reported in a quarter of an hour", not "this one unit is
// quiet".
// A job the board has finished with — the same set src/api/console.ts and
// src/api/driver.ts count out, for the same reason.
const FINISHED_JOB_STATUSES = ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] as const;

// How long the last extraction attempt stays evidence about now.
const AI_ATTEMPT_IS_RECENT_MS = 15 * 60 * 1000;

// A payment stuck awaiting authorisation for longer than this is a provider
// problem rather than a slow round trip. The retry sweep (Phase 15c) is what
// clears them; this is what makes the backlog visible while it does.
//
// EXPORTED so the console's drill-through list (src/api/console.ts) selects on
// exactly the threshold this probe counted on. Two copies of this number is how
// a banner saying "3 waiting" ends up opening a list of four.
export const PAYMENT_PENDING_AFTER_MS = 10 * 60 * 1000;

// A solver run slower than this was, for practical purposes, a timeout: the
// plan it produced is stale by the time anybody acts on it.
const SOLVER_SLOW_MS = 20_000;

// How long a solver run stays evidence about the present.
const RUN_IS_RECENT_MS = 15 * 60 * 1000;

export async function probeAll(db: PrismaClient, now: Date): Promise<ComponentReading[]> {
  return [
    await probeAi(db, now),
    await probeGps(db, now),
    await probeWebsocket(db),
    await probeSolver(db, now),
    await probePayments(db, now),
    await probeDispatchCore(db),
  ];
}

// THE AI IS THE ONE COMPONENT THE PROBE DOES NOT ASK DIRECTLY. Calling the
// model every fifteen seconds to find out whether it is up would cost more
// than using it. Intake writes this row on every real extraction attempt
// (src/ai/health.ts), so the probe only overrides it when the switch is on and
// otherwise leaves the last real verdict alone.
async function probeAi(db: PrismaClient, now: Date): Promise<ComponentReading> {
  if (await isChaosOn(db, 'LLM_DOWN')) {
    return { component: 'AI_EXTRACTION', state: 'DEGRADED', detail: 'forced by a chaos switch' };
  }

  // READ FROM THE ATTEMPT LOG, NOT FROM THE HEALTH ROW. Every extraction —
  // successful or not — writes an `ai_extractions` row (src/ai/store.ts), so
  // that table is the evidence and `system_health_states` is only the summary
  // this probe rewrites. Reading the summary to decide the summary was the
  // first version of this function and it could not recover: the health row's
  // `updated_at` moves every time the loop writes it, so a stale DEGRADED
  // reading refreshed its own timestamp forever and the banner never cleared.
  const lastAttempt = await db.aiExtraction.findFirst({
    orderBy: { eventTime: 'desc' },
    select: { eventTime: true, rawResponse: true },
  });

  // NOT TRIED RECENTLY IS NOT BROKEN. Nothing here calls the model on a timer
  // — that would cost more than using it — so with no recent attempt the
  // honest answer is that we do not know, and the ladder's job is to report
  // what an operator would EXPERIENCE. What they would experience right now is
  // an intake that has not failed.
  const isRecent =
    lastAttempt && now.getTime() - lastAttempt.eventTime.getTime() <= AI_ATTEMPT_IS_RECENT_MS;
  if (!isRecent) {
    return { component: 'AI_EXTRACTION', state: 'NORMAL', detail: 'no recent extraction attempt' };
  }

  const attempt = (lastAttempt.rawResponse ?? {}) as { status?: string; reason?: string };
  if (attempt.status === 'FALLBACK') {
    return {
      component: 'AI_EXTRACTION',
      state: 'DEGRADED',
      detail: `last extraction fell back (${attempt.reason ?? 'unknown reason'})`,
    };
  }

  return { component: 'AI_EXTRACTION', state: 'NORMAL', detail: null };
}

// WHICH VANS ARE SUPPOSED TO BE REPORTING?
//
// This probe used to take the NEWEST `last_location_at` in the whole fleet, and
// that was wrong in both directions at once. Too lenient, because one van that
// reported a minute ago held the whole fleet at NORMAL while twenty-three
// others sat hours stale. Too harsh, because most of those twenty-three had
// nothing to report — a van parked at a depot between jobs is not a broken GPS
// feed, it is a van parked at a depot.
//
// The population that matters is UNITS CURRENTLY ON A JOB. Those are the
// positions a driver's map draws and the only ones anybody is waiting on, and
// they are exactly the units the position feed writes for
// (src/commit/unitPosition.ts — a fix rides along with each ladder tap). A
// fleet with no live jobs has nothing to report and is NORMAL: reporting
// DEGRADED because nobody is working is how a banner becomes furniture.
//
// The threshold is imported rather than redeclared, so one driver's map and the
// fleet-wide banner cannot disagree about what "stale" means.
async function probeGps(db: PrismaClient, now: Date): Promise<ComponentReading> {
  const onJob = await db.unit.findMany({
    where: {
      assignedJobs: { some: { status: { notIn: [...FINISHED_JOB_STATUSES] } } },
    },
    select: { code: true, lastLocationAt: true },
  });

  if (onJob.length === 0) {
    return { component: 'GPS', state: 'NORMAL', detail: null };
  }

  // The OLDEST fix among them, not the newest. A van that stopped reporting an
  // hour ago is the problem; the one that reported a second ago is not evidence
  // that it isn't.
  const stale = onJob.filter((unit) => {
    if (!unit.lastLocationAt) return true;
    return now.getTime() - unit.lastLocationAt.getTime() > POSITION_STALE_AFTER_MS;
  });

  if (stale.length === 0) {
    return { component: 'GPS', state: 'NORMAL', detail: null };
  }

  return {
    component: 'GPS',
    state: 'DEGRADED',
    detail:
      stale.length === onJob.length
        ? `no crew on a job has reported a position in the last ${Math.round(POSITION_STALE_AFTER_MS / 60000)} minutes`
        : `${stale.length} of ${onJob.length} crews on a job have not reported a position recently`,
  };
}

// Two ways live updates stop working: somebody switched them off, or the Redis
// the Socket.IO adapter fans out through is gone. Both leave the console
// polling, so both read the same.
async function probeWebsocket(db: PrismaClient): Promise<ComponentReading> {
  if (await isChaosOn(db, 'WEBSOCKET_DOWN')) {
    return { component: 'WEBSOCKET', state: 'DEGRADED', detail: 'forced by a chaos switch' };
  }
  if (!(await redisAnswers(db))) {
    return { component: 'WEBSOCKET', state: 'DEGRADED', detail: 'the fan-out cache is unreachable' };
  }
  return { component: 'WEBSOCKET', state: 'NORMAL', detail: null };
}

async function probeSolver(db: PrismaClient, now: Date): Promise<ComponentReading> {
  if (await isChaosOn(db, 'SOLVER_TIMEOUT')) {
    return { component: 'SOLVER', state: 'DEGRADED', detail: 'forced by a chaos switch' };
  }

  const lastRun = await db.solverRun.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { wallClockMs: true, createdAt: true, timedOut: true },
  });
  // A run that struggled only says something about the planner while it is
  // still recent; an hour-old slow run is history, not a current state.
  const recent = lastRun && now.getTime() - lastRun.createdAt.getTime() < RUN_IS_RECENT_MS;
  if (!recent) return { component: 'SOLVER', state: 'NORMAL', detail: null };

  // The run's own verdict first — it knows whether it was cut short, which is
  // a stronger statement than a stopwatch reading.
  if (lastRun.timedOut) {
    return {
      component: 'SOLVER',
      state: 'DEGRADED',
      detail: 'the last plan hit its deadline; unreached jobs kept their assignment',
    };
  }
  if (lastRun.wallClockMs > SOLVER_SLOW_MS) {
    return {
      component: 'SOLVER',
      state: 'DEGRADED',
      detail: `the last plan took ${Math.round(lastRun.wallClockMs / 1000)}s`,
    };
  }
  return { component: 'SOLVER', state: 'NORMAL', detail: null };
}

async function probePayments(db: PrismaClient, now: Date): Promise<ComponentReading> {
  const stuck = await db.payment.count({
    where: {
      status: 'PENDING_AUTHORISATION',
      createdAt: { lt: new Date(now.getTime() - PAYMENT_PENDING_AFTER_MS) },
    },
  });
  if (stuck > 0) {
    return {
      component: 'PAYMENTS',
      state: 'DEGRADED',
      detail: `${stuck} authorisation${stuck === 1 ? '' : 's'} waiting on the provider`,
    };
  }
  return { component: 'PAYMENTS', state: 'NORMAL', detail: null };
}

// THE ONLY COMPONENT THAT CAN GO CRITICAL. Automatic dispatch is the solver
// queue: no Redis, no queue; no queue, no re-plan, and every assignment has to
// be made by a person. That is CRITICAL by the ladder's definition — the
// system is no longer deciding — and it is a defined workflow rather than an
// outage, because the queue stays visible and the writes stay audited.
async function probeDispatchCore(db: PrismaClient): Promise<ComponentReading> {
  if (await isChaosOn(db, 'REDIS_DOWN')) {
    return {
      component: 'DISPATCH_CORE',
      state: 'CRITICAL',
      detail: 'forced by a chaos switch: the solver queue is unreachable',
    };
  }
  if (!(await redisAnswers(db))) {
    return {
      component: 'DISPATCH_CORE',
      state: 'CRITICAL',
      detail: 'the solver queue is unreachable',
    };
  }
  return { component: 'DISPATCH_CORE', state: 'NORMAL', detail: null };
}

// One PING, and the switch counts as a "no" so that toggling Redis off in a
// demo takes both components that depend on it down together — which is what
// would really happen.
async function redisAnswers(db: PrismaClient): Promise<boolean> {
  if (await isChaosOn(db, 'REDIS_DOWN')) return false;
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
