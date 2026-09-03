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
import {
  labelForFault,
  labelForJobStatus,
  labelForSafetyLevel,
} from '../domain/driverNarrative.js';
import { isFaultCode } from '../domain/faults.js';
import { inWords as makeInWords } from '../domain/vehicleWords.js';

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
      // AND THE SAME RULE FOR ENUMS. A fleet manager is a customer, not an
      // operator, and their dashboard was rendering AWAITING_APPROVAL and
      // FLAT_BATTERY straight out of the database. Worded here rather than in
      // the browser for exactly the reason src/api/driver.ts is: it makes "no
      // enum reaches a customer" a property of this response that a test can
      // scan for, instead of a rule somebody has to remember in a template.
      activeIncidents: dashboard.activeIncidents.map(inWords),
      vehicles: dashboard.vehicles.map((vehicle) => ({
        ...vehicle,
        // Manufacturers are stored in SCREAMING_SNAKE — the fleet dashboard was
        // showing "TOYOTA Innova Crysta". src/domain/vehicleWords.ts already
        // owns this translation for the driver and the technician.
        make: makeInWords(vehicle.make) ?? vehicle.make,
        incidents: vehicle.incidents.map(inWords),
      })),
    });
  },
);

// One incident, with its three coded fields turned into words. The raw values
// are REPLACED rather than sat alongside: a field that carries both is a field
// somebody eventually renders the wrong half of.
function inWords<T extends { status: string; topFault: string | null }>(
  incident: T & { safetyLevel?: string },
): T {
  return {
    ...incident,
    status: labelForJobStatus(incident.status),
    ...(incident.safetyLevel === undefined
      ? {}
      : { safetyLevel: labelForSafetyLevel(incident.safetyLevel) }),
    // A fault the catalogue does not know is left exactly as it is rather than
    // guessed at — labelForFault is a total function over FaultCode only.
    topFault:
      incident.topFault && isFaultCode(incident.topFault)
        ? labelForFault(incident.topFault)
        : incident.topFault,
  };
}
