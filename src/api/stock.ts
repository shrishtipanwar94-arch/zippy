// THE PARTS SURFACE — four endpoints, two of them the technician's.
//
// GET  /technician/stock            what is in my van, and how sure we are
// POST /technician/stock/confirm    I counted it; here is what is there
// POST /jobs/:id/parts-used         I fitted these on this job
// GET  /units/:id/stock             the same van, seen by a dispatcher
//
// WHY THE LAST ONE IS GATED DIFFERENTLY. "May I see my own van" and "may I see
// any van" are different questions, so they are different resources
// (`vanStock` and `fleetStock` in src/auth/permissions.ts) rather than one
// resource plus an if-statement in this file. A technician holds the first and
// not the second, which is why /units/:id/stock does not need to work out
// whether the caller happens to be crewed to the unit they asked about.
//
// BOTH WRITES TAKE AN ID THE CLIENT MINTED and are safe to send twice. See
// src/commit/stockMovements.ts for what that id does.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { readVanStock } from '../commit/vanStock.js';
import { confirmVanStock } from '../commit/stockConfirmations.js';
import { declareConsumption } from '../commit/partsConsumption.js';

export const stockRouter = Router();

// The van a technician is crewed to right now. `Unit.currentTechnicianId` is
// the crewing field the seed fills and the technician surface has used since
// Phase 4 — one van per technician, so this is a lookup rather than a choice.
async function crewedUnitId(technicianId: string): Promise<string | null> {
  const unit = await prismaBase.unit.findFirst({
    where: { currentTechnicianId: technicianId },
    select: { id: true },
  });
  return unit?.id ?? null;
}

stockRouter.get(
  '/technician/stock',
  authenticate,
  requirePermission('read', 'vanStock'),
  async (req, res) => {
    const technicianId = req.auth?.actorId;
    if (!technicianId) {
      res.status(403).json({ error: 'not_a_technician' });
      return;
    }
    const unitId = await crewedUnitId(technicianId);
    if (!unitId) {
      // Not an error and not an empty list either: an empty list would read as
      // "your van is empty", which is a very different sentence.
      res.status(409).json({ error: 'not_crewed_to_a_van' });
      return;
    }

    const stock = await readVanStock(prismaBase, unitId, new Date());
    res.json(stock);
  },
);

// ---------------------------------------------------------------------------

const confirmSchema = z
  .object({
    // Minted by the phone at the moment of the tap. Each counted line derives
    // its row ids from this, so the whole count replays as one.
    confirmationId: z.string().min(8).max(100),
    counted: z
      .array(z.object({ partId: z.string().min(1), quantity: z.number().int().min(0) }).strict())
      .min(1)
      .max(100),
    confirmedAt: z.iso.datetime().optional(),
  })
  .strict();

stockRouter.post(
  '/technician/stock/confirm',
  authenticate,
  requirePermission('update', 'vanStock'),
  async (req, res) => {
    const technicianId = req.auth?.actorId;
    if (!technicianId) {
      res.status(403).json({ error: 'not_a_technician' });
      return;
    }
    const body = confirmSchema.parse(req.body);
    const unitId = await crewedUnitId(technicianId);
    if (!unitId) {
      res.status(409).json({ error: 'not_crewed_to_a_van' });
      return;
    }

    const result = await confirmVanStock(prismaBase, {
      unitId,
      technicianId,
      confirmationId: body.confirmationId,
      counted: body.counted,
      // When they counted, not when we heard. A count taken in a basement car
      // park and sent twenty minutes later is twenty minutes old, and the
      // confidence level has to say so.
      confirmedAt: body.confirmedAt ? new Date(body.confirmedAt) : new Date(),
    });

    res.json({ unitId, ...result });
  },
);

// ---------------------------------------------------------------------------

const consumptionSchema = z
  .object({
    declarationId: z.string().min(8).max(100),
    lines: z
      .array(z.object({ partId: z.string().min(1), quantity: z.number().int().min(1) }).strict())
      .min(1)
      .max(50),
    eventTime: z.iso.datetime().optional(),
  })
  .strict();

// Gated on `technicianAction` rather than on `vanStock`: this is the technician
// declaring what they did on a job, and it is refused for a job that is not
// theirs. The permission answers "may this role act in the field"; the commit
// module answers "on this job".
stockRouter.post(
  '/jobs/:id/parts-used',
  authenticate,
  requirePermission('update', 'technicianAction'),
  async (req, res) => {
    const technicianId = req.auth?.actorId;
    const jobId = req.params.id;
    if (!technicianId) {
      res.status(403).json({ error: 'not_a_technician' });
      return;
    }
    if (typeof jobId !== 'string' || jobId.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = consumptionSchema.parse(req.body);

    const result = await declareConsumption(prismaBase, {
      jobId,
      technicianId,
      declarationId: body.declarationId,
      lines: body.lines,
      eventTime: body.eventTime ? new Date(body.eventTime) : new Date(),
    });

    // EVERY OUTCOME IS 200, including REJECTED — the same rule the ladder
    // follows. A declaration can be replayed from a queue, so the status code
    // says "your request was processed" and the body says what it meant.
    res.json({ jobId, ...result });
  },
);

// ---------------------------------------------------------------------------

stockRouter.get(
  '/units/:id/stock',
  authenticate,
  requirePermission('read', 'fleetStock'),
  async (req, res) => {
    const unitId = req.params.id;
    if (typeof unitId !== 'string' || unitId.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const stock = await readVanStock(prismaBase, unitId, new Date());
    if (!stock) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(stock);
  },
);
