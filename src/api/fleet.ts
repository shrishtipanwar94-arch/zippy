// GET /fleet/dashboard — the fleet manager's own surface.
//
// One route, one read. Everything on it — active incidents, SLA met %,
// current exposure, mean resolution time, spend, per-vehicle history and the
// repeat-pattern flag — comes from src/commit/fleetDashboard.ts, which is the
// only place any of these numbers are computed. Nothing here decides anything.
//
// THE TENANT COMES FROM THE TOKEN, NEVER FROM A QUERY PARAMETER. A
// FLEET_MANAGER's token carries exactly one tenant id (issued at login,
// src/api/auth.ts) and that is the only tenant this route will ever read —
// the same rule src/api/vehicles.ts follows for the same reason. There is no
// `?tenantId=` to forget to check.

import { Router } from 'express';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { buildFleetDashboard } from '../commit/fleetDashboard.js';
import { formatRupees } from '../domain/money.js';

export const fleetRouter = Router();

fleetRouter.get(
  '/fleet/dashboard',
  authenticate,
  requirePermission('read', 'fleetDashboard'),
  async (req, res) => {
    const tenantId = req.auth?.tenantId ?? null;
    if (!tenantId) {
      // Reachable only by a token issued wrong — every real FLEET_MANAGER
      // login carries a tenant (src/api/auth.ts). Refusing rather than
      // guessing keeps that assumption checked instead of silently reading
      // nothing for nobody.
      res.status(409).json({ error: 'no_tenant_on_token' });
      return;
    }

    const dashboard = await buildFleetDashboard(prismaBase, tenantId);

    res.json({
      ...dashboard,
      // Rendered once, server-side, the same rule the driver's screen follows
      // for money (src/domain/money.ts is the one place paise become words):
      // two clients formatting the same paise figure differently is how a
      // dashboard and an invoice end up disagreeing about what something cost.
      currentExposureRupees: formatRupees(dashboard.currentExposurePaise),
      spendRupees: formatRupees(dashboard.spendPaise),
    });
  },
);
