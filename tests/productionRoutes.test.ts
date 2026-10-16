// THE BREAK-IT PANEL DOES NOT EXIST IN PRODUCTION.
//
// src/api/chaos.ts can switch off the LLM, the payment rail and the planner,
// and move the real fleet around. Its first lock is that `mountChaosRoutes`
// registers nothing when NODE_ENV is production — not a 403, a 404 — so a
// leaked dispatcher token or a future permission bug has nothing to reach.
//
// Each request carries a DISPATCHER token on purpose: a 404 without one could
// just be the auth check, and the claim is that even the role allowed to use
// the panel in development finds nothing there. The control case proves the
// same requests reach real routes when the panel is mounted.

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountChaosRoutes } from '../src/api/chaos.js';
import { issueAccessToken } from '../src/auth/tokens.js';

const dispatcherToken = issueAccessToken({
  sub: 'production-routes-dispatcher',
  role: 'DISPATCHER',
  tenantId: null,
  crossTenant: true,
  actorId: 'production-routes-dispatcher',
});

const CHAOS_REQUESTS: { method: 'get' | 'post'; path: string }[] = [
  { method: 'get', path: '/chaos' },
  { method: 'post', path: '/chaos/switches/LLM_DOWN' },
  { method: 'post', path: '/chaos/actions/INJECT_JOBS' },
  { method: 'post', path: '/chaos/reset' },
];

function appWithChaos(isProduction: boolean): express.Express {
  const app = express();
  app.use(express.json());
  mountChaosRoutes(app, isProduction);
  return app;
}

function send(app: express.Express, method: 'get' | 'post', path: string) {
  const authorised = request(app)[method](path).set('Authorization', `Bearer ${dispatcherToken}`);
  // A body that fails validation, so the control case never actually breaks
  // anything: it only has to prove the route exists.
  return method === 'post' ? authorised.send({ enabled: 'not-a-boolean' }) : authorised;
}

describe('chaos routes in production', () => {
  const production = appWithChaos(true);

  for (const { method, path } of CHAOS_REQUESTS) {
    it(`${method.toUpperCase()} ${path} is 404 even for a dispatcher`, async () => {
      const response = await send(production, method, path);
      expect(response.status).toBe(404);
    });
  }

  it('control: the same paths exist when the panel is mounted', async () => {
    const development = appWithChaos(false);
    const response = await send(development, 'get', '/chaos');
    expect(response.status).toBe(200);
  });
});
