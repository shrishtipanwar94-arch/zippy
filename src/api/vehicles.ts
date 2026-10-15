// VEHICLES — two endpoints.
//
// GET  /vehicles   the caller's own vehicles, in words a person recognises
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
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { vehicleFilingFilter } from '../auth/permissions.js';
import { registerVehicle } from '../commit/vehicleRegistration.js';
// `MARUTI_SUZUKI` is a database value; "Maruti Suzuki" is a car. Shared with
// the technician's board, which leaked the same string until Phase 22b.
import { inWords } from '../domain/vehicleWords.js';

export const vehiclesRouter = Router();

// GET /vehicles — WHAT A PERSON CALLS THEIR CAR.
//
// This exists because the driver's page used to ask them to type
// `vehicle-metrocab-1` into a text box. A database id is not something a
// stranded driver knows, can read off their vehicle, or should ever be shown:
// they know the number plate. The picker on the request screen is built from
// this, so the id travels in a value attribute and the human reads
// "DL04GH4001 · Maruti Swift".
//
// A DRIVER SEES WHAT THEY MAY FILE AGAINST, AND NOTHING ELSE.
//
// The comment that used to be here claimed the scoped `prisma` client already
// narrowed a driver to their own vehicles. It does not: the ownership
// extension covers the Job model only, so all this route ever had was the
// TENANT filter — and a Metrocab driver was handed both Metrocab cars in a
// dropdown, one of which `POST /jobs/intake` then refused. The rule now comes
// from `vehicleFilingFilter`, which intake uses too, so the list this returns
// cannot contain a vehicle intake would turn down.
//
// A DISPATCHER OR FLEET MANAGER IS ASKING A DIFFERENT QUESTION and is left
// alone. They are not filing as anybody — they are looking at a fleet's books,
// which the tenant filter already bounds. Narrowing them by `driverId` would
// return nothing at all, because neither has a Driver row.
vehiclesRouter.get(
  '/vehicles',
  authenticate,
  requirePermission('read', 'vehicle'),
  async (req, res) => {
    const filing = req.auth?.role === 'DRIVER' ? vehicleFilingFilter(req.auth.actorId) : {};

    const vehicles = await prisma.vehicle.findMany({
      where: filing,
      select: {
        id: true,
        registration: true,
        colour: true,
        profile: { select: { make: true, model: true } },
      },
      orderBy: { registration: 'asc' },
    });

    res.json({
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        registration: vehicle.registration,
        // One sentence rather than three fields, because the caller is a
        // dropdown and every consumer would otherwise join these itself.
        description: [vehicle.colour, inWords(vehicle.profile?.make), vehicle.profile?.model]
          .filter((part) => Boolean(part))
          .join(' '),
      })),
    });
  },
);

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
