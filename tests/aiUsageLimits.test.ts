// THE ASSISTANT'S SPENDING CEILING, AND THAT HITTING IT NEVER BLOCKS INTAKE
// (src/ai/usageLimits.ts, the describe route in src/api/intake.ts).
//
// Counted against an in-memory counter here so the rule can be tested without
// Redis or a clock. The second half pins the property that matters to a
// driver: a refused call answers in EXACTLY the shape of a model that is down,
// and tests/aiIntakeRoute.test.ts already proves intake completes end to end
// through the question picker and the classifier in that state.

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkAssistantAllowance } from '../src/ai/usageLimits.js';
import type { UsageCounter } from '../src/ai/usageLimits.js';
import { cappedResponse } from '../src/api/intake.js';
import { createApp } from '../src/api/app.js';
import { issueAccessToken } from '../src/auth/tokens.js';

function memoryCounter(): UsageCounter {
  const counts = new Map<string, number>();
  return {
    increment: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

const NOW = new Date('2026-10-17T09:30:00.000Z');

describe('checkAssistantAllowance', () => {
  it('allows calls under both ceilings', async () => {
    const decision = await checkAssistantAllowance({
      ip: '10.0.0.1', now: NOW, counter: memoryCounter(), hourlyLimitPerIp: 3, dailyCap: 10,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('refuses one caller past their hourly limit, without using up the daily cap', async () => {
    const counter = memoryCounter();
    const input = { ip: '10.0.0.1', now: NOW, counter, hourlyLimitPerIp: 2, dailyCap: 3 };
    await checkAssistantAllowance(input);
    await checkAssistantAllowance(input);
    const third = await checkAssistantAllowance(input);
    expect(third).toMatchObject({ allowed: false, reason: 'RATE_LIMITED' });

    // A different caller still has the deployment's remaining daily allowance.
    const other = await checkAssistantAllowance({ ...input, ip: '10.0.0.2' });
    expect(other).toEqual({ allowed: true });
  });

  it('refuses everyone once the daily cap is reached, with a sentence for the driver', async () => {
    const counter = memoryCounter();
    for (let caller = 1; caller <= 3; caller++) {
      await checkAssistantAllowance({ ip: `10.0.1.${caller}`, now: NOW, counter, hourlyLimitPerIp: 5, dailyCap: 3 });
    }
    const fourth = await checkAssistantAllowance({ ip: '10.0.1.9', now: NOW, counter, hourlyLimitPerIp: 5, dailyCap: 3 });
    expect(fourth).toMatchObject({ allowed: false, reason: 'DAILY_CAP_REACHED' });
    if (!fourth.allowed) expect(fourth.message).toMatch(/limit for today.*questions instead/);
  });

  it('fails closed when the counter cannot be reached', async () => {
    const broken: UsageCounter = { increment: async () => { throw new Error('redis down'); } };
    const decision = await checkAssistantAllowance({
      ip: '10.0.0.1', now: NOW, counter: broken, hourlyLimitPerIp: 5, dailyCap: 5,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'LIMITER_UNAVAILABLE' });
  });
});

describe('a refused call takes the same path as a model that is down', () => {
  it('has exactly the degraded shape the driver screen falls back on', async () => {
    // The live model-down answer, from the real route (the suite runs with no
    // LLM key, so the extractor reports itself unavailable).
    const token = issueAccessToken({
      sub: 'usage-limits-driver', role: 'DRIVER', tenantId: null, crossTenant: false, actorId: 'usage-limits-driver',
    });
    const modelDown = await request(createApp())
      .post('/jobs/intake/describe')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'my car will not start' });
    expect(modelDown.status).toBe(200);

    // Same fields (plus the sentence for the driver), and the same values in
    // every field the screen branches on.
    const capped = cappedResponse('DAILY_CAP_REACHED', 'limit reached');
    const cappedFields = Object.keys(capped).filter((field) => field !== 'message').sort();
    expect(cappedFields).toEqual(Object.keys(modelDown.body).sort());
    for (const field of ['degraded', 'extractionId', 'symptoms', 'safety', 'hypothesis']) {
      expect(capped[field as keyof typeof capped]).toEqual(modelDown.body[field]);
    }
  });
});
