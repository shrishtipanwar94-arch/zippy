// REGISTERING A VEHICLE — one endpoint, one rule worth having a route for.
//
// POST /vehicles   put a vehicle on a tenant's books
//
// A fleet manager adds vehicles to their own fleet; a dispatcher can add one on
// their behalf. The rule the route exists to enforce is that a vehicle belongs
// to exactly one tenant — src/commit/vehicleRegistration.ts carries the full
// argument for why that is a dispatch problem rather than paperwork.
//
// A FLEET MANAGER MAY ONLY REGISTER INTO THEIR OWN TENANT, and the token says
// which that is, so the body does not get to. Trusting a `tenantId` field from
// a fleet manager's browser would make the whole tenancy layer advisory.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { registerVehicle } from '../commit/vehicleRegistration.js';

export const vehiclesRouter = Router();

const registerSchema = z
  .object({
    driverId: z.string().min(1),
    profileId: z.string().min(1),
    registration: z.string().min(4).max(20),
    colour: z.string().min(1).max(40),
    // Only a DISPATCHER may name a tenant, because only a DISPATCHER is not
    // scoped to one. A fleet manager's own tenant comes off their token below.
    tenantId: z.string().min(1).nullable().optional(),
  })
  .strict();

vehiclesRouter.post(
  '/vehicles',
  authenticate,
  requirePermission('create', 'vehicle'),
  async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: 'invalid_body', detail: parsed.error.issues });
      return;
    }

    const callerTenantId = req.auth?.tenantId ?? null;
    const tenantId = callerTenantId ?? parsed.data.tenantId ?? null;

    const result = await registerVehicle(prismaBase, {
      driverId: parsed.data.driverId,
      tenantId,
      profileId: parsed.data.profileId,
      registration: parsed.data.registration,
      colour: parsed.data.colour,
    });

    if (result.outcome === 'REJECTED') {
      // 409, not 422: the body is well formed and the request would have been
      // valid yesterday. What is wrong is the state of the world.
      const status = result.code === 'DRIVER_NOT_FOUND' ? 404 : 409;
      res.status(status).json({ error: result.code, detail: result.detail });
      return;
    }

    res.status(201).json({ vehicleId: result.vehicleId });
  },
);
