// THE CHAOS CONTROLS OVER HTTP, against the real `zippy_test` Postgres.
//
// THE PHASE'S OWN CHECK, AS A TEST: every control degrades VISIBLY, and the
// system recovers on its own when it is switched back. "Recovers on its own"
// is the half that matters — a control that leaves the system stuck is the
// worst possible demo failure — and here it means the health check re-runs the
// probes and finds the component healthy again, with nobody clearing a flag by
// hand.
//
// SCOPED ASSERTIONS. `zippy_test` is shared and vitest runs files in parallel,
// so nothing below asserts on the SYSTEM mode: the GPS probe reads a fleet
// that other suites move, and the AI row belongs to the intake tests. Every
// assertion names the one component the switch under test controls. This file
// is the only one that touches `chaos_switches`.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { resetChaos } from '../src/chaos/switches.js';
import { runHealthCheck } from '../src/health/loop.js';
import { readComponentStates } from '../src/health/state.js';
import type { HealthComponent } from '../src/domain/healthLadder.js';

const app = createApp();

function token(role: 'DISPATCHER' | 'DRIVER'): string {
  return issueAccessToken({
    sub: `chaos-${role.toLowerCase()}`,
    role,
    tenantId: null,
    crossTenant: role === 'DISPATCHER',
    actorId: `chaos-${role.toLowerCase()}`,
  });
}

function flip(name: string, enabled: boolean) {
  return request(app)
    .post(`/chaos/switches/${name}`)
    .set('Authorization', `Bearer ${token('DISPATCHER')}`)
    .send({ enabled });
}

async function stateOf(component: HealthComponent) {
  const readings = await readComponentStates(prismaBase);
  return readings.find((reading) => reading.component === component);
}

describe('the chaos switches move the ladder and let go of it', () => {
  afterEach(async () => {
    // Whatever a test did, put it back — and re-probe, so a later test never
    // reads a state this one forced.
    await resetChaos(prismaBase);
    await runHealthCheck(prismaBase);
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('takes automatic dispatch CRITICAL when Redis is switched off', async () => {
    const response = await flip('REDIS_DOWN', true);

    expect(response.status).toBe(200);
    const core = await stateOf('DISPATCH_CORE');
    expect(core?.state).toBe('CRITICAL');
    expect(core?.detail).toContain('chaos switch');

    // And the whole system is CRITICAL, which is the one roll-up safe to
    // assert here: no other suite can produce it.
    expect(response.body.health.mode).toBe('CRITICAL');
    // The banner says what an operator can still DO, and no longer promises the
    // manual assignment screen that was cut at Phase 9 and only admitted at
    // 22c — tests/degradation.test.ts holds the assertion that keeps it cut.
    expect(response.body.health.message).toContain('queue stays visible');
  });

  it('recovers on its own once the switch goes back', async () => {
    await flip('REDIS_DOWN', true);
    expect((await stateOf('DISPATCH_CORE'))?.state).toBe('CRITICAL');

    await flip('REDIS_DOWN', false);
    // Nothing cleared the flag by hand: the probes ran again and found Redis
    // answering. This is the loop's job in production, on a fifteen-second
    // timer; the route runs it immediately so a demo does not have to wait.
    expect((await stateOf('DISPATCH_CORE'))?.state).toBe('NORMAL');
  });

  it('degrades the symptom assistant without touching dispatch', async () => {
    await flip('LLM_DOWN', true);

    expect((await stateOf('AI_EXTRACTION'))?.state).toBe('DEGRADED');
    // The point of the ladder: a broken assistant is not a broken dispatcher.
    expect((await stateOf('DISPATCH_CORE'))?.state).toBe('NORMAL');
  });

  it('degrades live updates and the planner independently', async () => {
    await flip('WEBSOCKET_DOWN', true);
    expect((await stateOf('WEBSOCKET'))?.state).toBe('DEGRADED');
    await flip('WEBSOCKET_DOWN', false);

    await flip('SOLVER_TIMEOUT', true);
    expect((await stateOf('SOLVER'))?.state).toBe('DEGRADED');
  });

  it('refuses an unknown switch rather than inventing one', async () => {
    const response = await flip('MAKE_IT_RAIN', true);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('unknown_switch');
  });

  it('is dispatcher-only', async () => {
    const response = await request(app)
      .post('/chaos/switches/LLM_DOWN')
      .set('Authorization', `Bearer ${token('DRIVER')}`)
      .send({ enabled: true });

    expect(response.status).toBe(403);
  });

  it('puts everything back in one call', async () => {
    await flip('REDIS_DOWN', true);
    await flip('LLM_DOWN', true);

    const response = await request(app)
      .post('/chaos/reset')
      .set('Authorization', `Bearer ${token('DISPATCHER')}`)
      .send({});

    expect(response.status).toBe(200);
    expect((await stateOf('DISPATCH_CORE'))?.state).toBe('NORMAL');
    const switches = await prismaBase.chaosSwitch.findMany({ where: { enabled: true } });
    expect(switches).toHaveLength(0);
  });
});
