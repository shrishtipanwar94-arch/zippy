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

// How stale the newest position in the fleet may be before the map is lying.
// Units report on movement rather than on a timer, so this is generous: it is
// "nothing at all has reported in a quarter of an hour", not "this one unit is
// quiet".
const GPS_STALE_AFTER_MS = 15 * 60 * 1000;

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

async function probeGps(db: PrismaClient, now: Date): Promise<ComponentReading> {
  const newest = await db.unit.findFirst({
    where: { lastLocationAt: { not: null } },
    orderBy: { lastLocationAt: 'desc' },
    select: { lastLocationAt: true },
  });

  const at = newest?.lastLocationAt;
  if (!at) {
    return { component: 'GPS', state: 'DEGRADED', detail: 'no unit has ever reported a position' };
  }

  const ageMs = now.getTime() - at.getTime();
  if (ageMs > GPS_STALE_AFTER_MS) {
    return {
      component: 'GPS',
      state: 'DEGRADED',
      detail: `newest fleet position is ${Math.round(ageMs / 60000)} minutes old`,
    };
  }
  return { component: 'GPS', state: 'NORMAL', detail: null };
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
