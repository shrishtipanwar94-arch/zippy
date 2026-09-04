import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prisma } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import {
  describePositionAge,
  POSITION_STALE_AFTER_MS,
} from '../src/commit/unitPosition.js';

/**
 * These run without Postgres or Redis. That is the point: the health endpoint
 * must degrade to 503 rather than throw, and the process must keep answering.
 * When infrastructure is up (locally, or in a later CI job) the same assertions
 * still hold — status is then "ok" with a 200.
 */
const app = createApp();

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  redis.disconnect();
});

describe('GET /health', () => {
  it('always returns the { status, db, redis, uptime } envelope', async () => {
    const res = await request(app).get('/health');

    expect(res.body).toMatchObject({
      status: expect.any(String),
      db: expect.any(Boolean),
      redis: expect.any(Boolean),
      uptime: expect.any(Number),
    });
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('never returns a hardcoded 200 — the code tracks the probes', async () => {
    const res = await request(app).get('/health');

    if (res.body.db && res.body.redis) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    } else {
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
    }
  });

  it('echoes an incoming x-request-id back on the response', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'test-req-123');
    expect(res.headers['x-request-id']).toBe('test-req-123');
  });
});

// THE THREE TIERS OF "HOW OLD IS THIS DOT", which is the sentence a stranded
// driver reads next to a map of somebody coming to them.
//
// A map that lies is worse than no map, and the whole defence against that is
// this function — so the boundaries are pinned rather than left to whoever next
// edits the wording. Pure, so it needs no database: `now` is passed in.
describe('describePositionAge — the driver is told how much to trust the dot', () => {
  const now = new Date('2026-09-04T10:00:00.000Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  // TIER 1 — fresh enough to say nothing. A caption on a dot that is thirty
  // seconds old is noise, and noise is what stops the other two tiers being
  // read when they appear.
  it('says nothing at all about a fix under two minutes old', () => {
    expect(describePositionAge(minutesAgo(0), now)).toEqual({ text: null, stale: false });
    expect(describePositionAge(minutesAgo(1), now)).toEqual({ text: null, stale: false });
  });

  // TIER 2 — old enough to mention, not old enough to disown. The dot is still
  // presented as where they are; the age is offered so the driver can judge.
  it('gives the age in minutes between two minutes and the stale threshold', () => {
    expect(describePositionAge(minutesAgo(4), now)).toEqual({
      text: 'Last seen 4 minutes ago',
      stale: false,
    });
    expect(describePositionAge(minutesAgo(14), now)).toEqual({
      text: 'Last seen 14 minutes ago',
      stale: false,
    });
  });

  // TIER 3 — past the threshold the screen STOPS DESCRIBING A POSITION and
  // starts describing a last known one. This is the tier the rule exists for:
  // the dot stays (silence is not a better answer to "where are they") but
  // nothing on screen calls it current any more.
  it('stops calling it a current position once it is stale', () => {
    expect(describePositionAge(minutesAgo(15), now)).toEqual({
      text: 'This is their last known position, not where they are now.',
      stale: true,
    });
    expect(describePositionAge(minutesAgo(90), now)).toEqual({
      text: 'This is their last known position, not where they are now.',
      stale: true,
    });
  });

  // The threshold is shared with the fleet-wide GPS probe on purpose, so one
  // driver's map and the operator's banner cannot disagree about "stale".
  it('turns over at exactly the threshold the health probe uses', () => {
    const justInside = new Date(now.getTime() - (POSITION_STALE_AFTER_MS - 1_000));
    const justOutside = new Date(now.getTime() - POSITION_STALE_AFTER_MS);
    expect(describePositionAge(justInside, now).stale).toBe(false);
    expect(describePositionAge(justOutside, now).stale).toBe(true);
  });

  // NEVER A CONFIDENT DOT WITH NOTHING BEHIND IT. No fix at all is the most
  // important case to get right, because it is the one where there is nothing
  // on the map to argue with.
  it('admits when there is no position at all', () => {
    expect(describePositionAge(null, now)).toEqual({
      text: 'We do not have their position yet.',
      stale: true,
    });
  });
});
