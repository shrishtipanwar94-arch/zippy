// POST /jobs/intake              a breakdown report becomes a job
// GET  /jobs/:id/next-question   what intake wants to know next, if anything
// POST /jobs/:id/answers         record one answer, get the next question
//
// AUTHORISATION HAPPENS HERE, WRITES HAPPEN ON THE UNSCOPED CLIENT.
// The scoped `prisma` client (tenant filter + row ownership) is used to resolve
// the driver, the vehicle and the job — so a caller who cannot see a row gets a
// 404 from the lookup and never reaches the service. The intake service then
// writes through `prismaBase`, because the rows it appends (job events, fault
// hypotheses, intake answers) have no tenant column of their own and are
// reached only through a job id this route has already proved the caller owns.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { symptomPayloadSchema } from '../domain/symptoms.js';
import { safetyContextSchema } from '../domain/safety.js';
import { locationSchema } from '../domain/location.js';
import { createIntakeJob } from '../intake/createJob.js';
import { recordIntakeAnswer, nextQuestionFor } from '../intake/answers.js';
import { IntakeError, statusForIntakeError } from '../intake/errors.js';

export const intakeRouter = Router();

intakeRouter.use(authenticate);

const intakeSchema = z.object({
  // A DRIVER files for themselves and this is ignored. A DISPATCHER taking a
  // call on the phone files on someone's behalf and must name them.
  driverId: z.string().min(1).optional(),
  vehicleId: z.string().min(1),
  symptoms: symptomPayloadSchema,
  // `prefault`, not `default`: an omitted block is parsed as `{}` so every
  // field inside falls back to its own declared default.
  safety: safetyContextSchema.prefault({}),
  location: locationSchema,
});

const answerSchema = z.object({
  questionCode: z.string().min(1),
  answer: z.string().min(1),
});

function sendIntakeError(error: unknown, res: import('express').Response): boolean {
  if (!(error instanceof IntakeError)) return false;
  res.status(statusForIntakeError(error)).json({ error: error.code.toLowerCase() });
  return true;
}

intakeRouter.post('/jobs/intake', requirePermission('create', 'job'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }

  const body = intakeSchema.parse(req.body);
  const driverId = auth.role === 'DRIVER' ? auth.actorId : body.driverId;
  if (!driverId) {
    res.status(400).json({ error: 'driver_id_required' });
    return;
  }

  // Both reads go through the scoped client: a caller outside the driver's
  // tenant sees nothing here and gets a 404, never a 403 — 403 would confirm
  // the driver exists.
  const driver = await prisma.driver.findFirst({
    where: { id: driverId },
    select: { id: true, tenantId: true },
  });
  if (!driver) {
    res.status(404).json({ error: 'driver_not_found' });
    return;
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: body.vehicleId, driverId: driver.id },
    select: { id: true },
  });
  if (!vehicle) {
    res.status(404).json({ error: 'vehicle_not_found' });
    return;
  }

  try {
    const result = await createIntakeJob(prismaBase, {
      driverId: driver.id,
      vehicleId: vehicle.id,
      tenantId: driver.tenantId,
      symptoms: body.symptoms,
      safety: body.safety,
      location: body.location,
      actor: { role: auth.role, id: auth.userId },
      at: new Date(),
    });
    res.status(201).json(result);
  } catch (error) {
    if (!sendIntakeError(error, res)) throw error;
  }
});

// Resolves a job through the scoped client. Returns null when the caller may
// not see it, which the routes below turn into a 404.
async function visibleJobId(id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  const job = await prisma.job.findFirst({ where: { id }, select: { id: true } });
  return job?.id ?? null;
}

intakeRouter.get('/jobs/:id/next-question', requirePermission('read', 'job'), async (req, res) => {
  const jobId = await visibleJobId(req.params.id);
  if (!jobId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  try {
    res.json(await nextQuestionFor(prismaBase, jobId));
  } catch (error) {
    if (!sendIntakeError(error, res)) throw error;
  }
});

intakeRouter.post('/jobs/:id/answers', requirePermission('create', 'job'), async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }

  const body = answerSchema.parse(req.body);
  const jobId = await visibleJobId(req.params.id);
  if (!jobId) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  try {
    const result = await recordIntakeAnswer(prismaBase, {
      jobId,
      questionCode: body.questionCode,
      answer: body.answer,
      actor: { role: auth.role, id: auth.userId },
      at: new Date(),
    });
    res.status(201).json(result);
  } catch (error) {
    if (!sendIntakeError(error, res)) throw error;
  }
});
