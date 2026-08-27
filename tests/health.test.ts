import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prisma } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';

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
