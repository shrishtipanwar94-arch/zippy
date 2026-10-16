// THE BREAK-IT PANEL — dispatcher-only, and absent from a production build.
//
// GET  /chaos                     what is switched on, and the ladder's state
// POST /chaos/switches/:name      turn one failure mode on or off
// POST /chaos/actions/:name       do one thing to the real fleet
// POST /chaos/reset               everything back to normal
//
// TWO LOCKS, NOT ONE.
//   1. `mountChaosRoutes` returns without registering anything when NODE_ENV
//      is production. The routes do not 403 there — they do not EXIST, so a
//      misconfigured role, a leaked token or a future permission bug cannot
//      reach them.
//   2. In dev they still require a DISPATCHER's `chaosControl` permission,
//      because a demo build is still a build with users in it.
//
// The first lock is the one that matters, and it is why this is a mount
// function rather than an exported router: a router exported at module scope
// is a router somebody can mount by accident.

import { Router } from 'express';
import type { Express } from 'express';
import { z } from 'zod';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import {
  isChaosSwitchName,
  readChaosSwitches,
  resetChaos,
  setChaosSwitch,
} from '../chaos/switches.js';
import {
  advanceTime,
  breakUnit,
  declineDestination,
  injectJobs,
  isChaosActionName,
  takeTechnicianOffline,
} from '../chaos/actions.js';
import { readSystemHealth } from '../health/state.js';
import { runHealthCheck } from '../health/loop.js';
import { suppressLiveUpdates } from '../realtime/server.js';

const switchSchema = z.object({ enabled: z.boolean() });

const actionSchema = z.object({
  // Which technician, unit or job to act on. Omitted means "pick one" — a
  // demo should not have to look up an id to break something.
  targetId: z.string().min(1).nullable().default(null),
  // Only INJECT_JOBS reads this. Capped: this goes through real intake, and a
  // typo asking for ten thousand jobs would be a long afternoon.
  count: z.number().int().min(1).max(50).default(5),
  // Only ADVANCE_TIME reads this. Capped at a day: past that the board is not
  // being demonstrated, it is being invented.
  minutes: z.number().int().min(1).max(1440).default(10),
});

// `isProduction` is a parameter only so a test can build a production-shaped
// app without restarting the process with NODE_ENV=production (config is read
// once, at import). Every real caller passes nothing and gets the real config.
export function mountChaosRoutes(app: Express, isProduction: boolean = config.isProduction): void {
  if (isProduction) {
    logger.info('chaos controls are not mounted in production');
    return;
  }

  const router = Router();

  // A restarted web process has a fresh in-memory flag and a database that may
  // still say live updates are off. Reading it once at mount is what stops the
  // two disagreeing until somebody happens to toggle the switch again.
  void applyStoredWebSocketSwitch();

  router.get('/chaos', authenticate, requirePermission('read', 'chaosControl'), async (_req, res) => {
    res.json({
      switches: await readChaosSwitches(prismaBase),
      health: await readSystemHealth(prismaBase),
    });
  });

  router.post(
    '/chaos/switches/:name',
    authenticate,
    requirePermission('update', 'chaosControl'),
    async (req, res) => {
      const name = String(req.params.name ?? '');
      if (!isChaosSwitchName(name)) {
        res.status(404).json({ error: 'unknown_switch' });
        return;
      }

      const body = switchSchema.parse(req.body ?? {});
      await setChaosSwitch(prismaBase, name, body.enabled, body.enabled ? 'forced by a dispatcher' : null);

      // The socket server lives in THIS process, so the switch has to be
      // applied here as well as stored. The row is what the worker's health
      // probe reads; this is what actually drops the connections.
      if (name === 'WEBSOCKET_DOWN') suppressLiveUpdates(body.enabled);

      // RUN THE PROBES IMMEDIATELY rather than waiting up to fifteen seconds
      // for the loop. The phase's check is that a control degrades VISIBLY and
      // recovers on its own; the loop is what makes the second half true, and
      // this is what makes the first half instant enough to demonstrate.
      await runHealthCheck(prismaBase);

      res.json({ switch: name, enabled: body.enabled, health: await readSystemHealth(prismaBase) });
    },
  );

  router.post(
    '/chaos/actions/:name',
    authenticate,
    requirePermission('update', 'chaosControl'),
    async (req, res) => {
      const name = String(req.params.name ?? '');
      if (!isChaosActionName(name)) {
        res.status(404).json({ error: 'unknown_action' });
        return;
      }

      const body = actionSchema.parse(req.body ?? {});
      res.json(await runAction(name, body));
    },
  );

  router.post(
    '/chaos/reset',
    authenticate,
    requirePermission('update', 'chaosControl'),
    async (_req, res) => {
      await resetChaos(prismaBase);
      await runHealthCheck(prismaBase);
      res.json({ reset: true, health: await readSystemHealth(prismaBase) });
    },
  );

  app.use(router);
  logger.warn('chaos controls mounted — this build can break itself on purpose');
}

async function applyStoredWebSocketSwitch(): Promise<void> {
  const stored = await readChaosSwitches(prismaBase);
  const websocket = stored.find((row) => row.name === 'WEBSOCKET_DOWN');
  if (websocket?.enabled) suppressLiveUpdates(true);
}

function runAction(name: string, body: z.infer<typeof actionSchema>) {
  if (name === 'TECHNICIAN_OFFLINE') return takeTechnicianOffline(prismaBase, body.targetId);
  if (name === 'BREAK_UNIT') return breakUnit(prismaBase, body.targetId);
  if (name === 'DECLINE_DESTINATION') return declineDestination(prismaBase, body.targetId);
  if (name === 'ADVANCE_TIME') return advanceTime(prismaBase, body.minutes);
  return injectJobs(prismaBase, body.count);
}
