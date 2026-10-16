// HOW MANY ASSISTANT CALLS A PUBLIC LINK MAY MAKE.
//
// The deployed demo is a public URL with a real model key behind it, and
// anyone with the link can type into the driver's describe box. Two ceilings,
// checked before every call in production:
//
//   per caller IP, per hour   — one curious visitor cannot drain the key
//   for the deployment, per UTC day — a crowd cannot either
//
// PAST A CEILING, NOTHING BREAKS. The route answers exactly as it does when the
// model is down — degraded, with a sentence for the driver — and the driver
// carries on with the question picker and the rule-based classifier. A capped
// assistant is a slower intake, never a refused request for help.
//
// COUNTED IN REDIS, which is cache and queues only (invariant 1): a counter
// that resets with Redis loses nothing that matters. If Redis cannot be
// reached the call is NOT made — failing closed costs one driver the
// assistant, failing open could cost the whole key.

import { redis } from '../infra/redis.js';

export type UsageCounter = {
  // Adds one to `key` and returns the new count; the key expires `ttlSeconds`
  // after it was first created.
  increment: (key: string, ttlSeconds: number) => Promise<number>;
};

export const redisUsageCounter: UsageCounter = {
  increment: async (key, ttlSeconds) => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  },
};

export type AssistantAllowance =
  | { allowed: true }
  | { allowed: false; reason: 'RATE_LIMITED' | 'DAILY_CAP_REACHED' | 'LIMITER_UNAVAILABLE'; message: string };

export type AllowanceInput = {
  ip: string;
  now: Date;
  counter: UsageCounter;
  hourlyLimitPerIp: number;
  dailyCap: number;
};

const HOUR_SECONDS = 60 * 60;
const TWO_DAYS_SECONDS = 2 * 24 * HOUR_SECONDS;

// The words the driver reads. Each says what happens next, not just what went
// wrong, because the person reading it is standing next to a broken car.
const MESSAGES = {
  RATE_LIMITED:
    'You have used the assistant a lot in the last hour, so we will ask a few quick questions instead. This does not delay anyone reaching you.',
  DAILY_CAP_REACHED:
    'Our assistant has reached its limit for today, so we will ask a few quick questions instead. This does not delay anyone reaching you.',
  LIMITER_UNAVAILABLE:
    'Our assistant is unavailable right now, so we will ask a few quick questions instead. This does not delay anyone reaching you.',
};

export async function checkAssistantAllowance(input: AllowanceInput): Promise<AssistantAllowance> {
  const hour = input.now.toISOString().slice(0, 13); // 2026-10-17T09
  const day = input.now.toISOString().slice(0, 10); // 2026-10-17
  try {
    // Per IP first: a visitor over their own limit must not use up the
    // deployment's daily allowance on calls that will be refused anyway.
    const fromThisIp = await input.counter.increment(`ai:ip:${input.ip}:${hour}`, HOUR_SECONDS);
    if (fromThisIp > input.hourlyLimitPerIp) {
      return { allowed: false, reason: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED };
    }
    const today = await input.counter.increment(`ai:day:${day}`, TWO_DAYS_SECONDS);
    if (today > input.dailyCap) {
      return { allowed: false, reason: 'DAILY_CAP_REACHED', message: MESSAGES.DAILY_CAP_REACHED };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'LIMITER_UNAVAILABLE', message: MESSAGES.LIMITER_UNAVAILABLE };
  }
}
