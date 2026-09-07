// POST /jobs/intake/describe     free text becomes a filled-in form, unconfirmed
// POST /jobs/intake              a breakdown report becomes a job
// GET  /jobs/:id/next-question   what intake wants to know next, if anything
// POST /jobs/:id/answers         record one answer, get the next question
//
// /describe IS NOT A JOB. It writes one AiExtraction row and returns what the
// model read; it creates nothing, dispatches nothing and commits nothing. The
// driver then confirms or corrects the fields and posts them to /jobs/intake
// like any other caller, which is what makes the AI path and the picker path
// the same path from the second request onwards (invariant 5).
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
import { visibleJobId } from './visibleJob.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { vehicleFilingFilter } from '../auth/permissions.js';
import { symptomPayloadSchema } from '../domain/symptoms.js';
import { safetyReportSchema } from '../domain/safety.js';
import { locationSchema } from '../domain/location.js';
import { createIntakeJob } from '../intake/createJob.js';
import { extractSymptoms } from '../ai/extractSymptoms.js';
import { recordOutcomeHealth } from '../ai/health.js';
import { storeExtraction } from '../ai/store.js';
import { buildHypothesisView } from '../domain/hypothesisView.js';
import { logger } from '../infra/logger.js';
import { recordIntakeAnswer, nextQuestionFor } from '../intake/answers.js';
import { driverMessageFor, IntakeError, statusForIntakeError } from '../intake/errors.js';

export const intakeRouter = Router();

// Per route, never `intakeRouter.use(authenticate)` — see the note in jobs.ts:
// a path-less router `use` also guards everything mounted after the router.

const intakeSchema = z.object({
  // A DRIVER files for themselves and this is ignored. A DISPATCHER taking a
  // call on the phone files on someone's behalf and must name them.
  driverId: z.string().min(1).optional(),
  vehicleId: z.string().min(1),
  symptoms: symptomPayloadSchema,
  // `prefault`, not `default`: an omitted block is parsed as `{}` so every
  // field inside falls back to its own declared default. A caller that sends no
  // safety block at all still gets correct triage, because the fact that
  // matters most — on a highway or not — is derived from the location rather
  // than read from here.
  safety: safetyReportSchema.prefault({}),
  location: locationSchema,
  // WHAT THE DRIVER IS CONFIRMING, when they came through /describe. Optional
  // because the picker path has no extraction, and never trusted for anything
  // but the audit trail: the symptoms above are what the job is built from,
  // whether the driver kept the extracted ones or changed every field.
  extractionId: z.string().min(1).optional(),
  // The sentence they typed, stored verbatim on the symptom report so an
  // extraction can be argued with against what was actually said.
  rawText: z.string().max(2000).optional(),
});

const answerSchema = z.object({
  questionCode: z.string().min(1),
  answer: z.string().min(1),
});

const describeSchema = z.object({
  // Long enough for a rambling voice transcript, short enough that nobody is
  // pasting a novel into the model on our bill.
  text: z.string().min(1).max(2000),
});

function sendIntakeError(error: unknown, res: import('express').Response): boolean {
  if (!(error instanceof IntakeError)) return false;
  // `error` stays the code, because clients and tests match on it. `message` is
  // added only when the thrower wrote one for a person — see driverMessageFor.
  // Without it the driver's page shows the code, and "outside_service_area" is
  // exactly the enum that is never supposed to reach a driver.
  const message = driverMessageFor(error);
  res.status(statusForIntakeError(error)).json({
    error: error.code.toLowerCase(),
    ...(message ? { message } : {}),
  });
  return true;
}

// WHAT THE MODEL READ, FOR THE DRIVER TO CONFIRM.
//
// Registered before /jobs/intake for no routing reason — Express matches these
// two literal paths unambiguously — but because it is the step that comes
// first, and the file reads in the order a driver moves through it.
//
// A DEGRADED ANSWER IS STILL A 200. "The model is unavailable, use the picker"
// is a successful answer to "what can you read from this", and turning it into
// a 5xx would make every client treat a working degraded path as a broken one.
intakeRouter.post(
  '/jobs/intake/describe',
  authenticate,
  requirePermission('create', 'job'),
  async (req, res) => {
    const body = describeSchema.parse(req.body);
    const outcome = await extractSymptoms(body.text);

    // The health row moves on every attempt, so an operator watching the
    // console sees the extractor go down on the first driver it fails, not
    // when someone thinks to check.
    await recordOutcomeHealth(prismaBase, outcome);

    if (outcome.status === 'FALLBACK') {
      await storeExtraction(prismaBase, { rawText: body.text, outcome, confidence: null });
      res.json({
        degraded: true,
        reason: outcome.reason,
        extractionId: null,
        symptoms: null,
        safety: null,
        hypothesis: null,
      });
      return;
    }

    const hypothesis = buildHypothesisView({
      symptoms: outcome.symptoms,
      urgencySignals: outcome.extraction.urgencySignals,
      vehicleContext: outcome.extraction.vehicleContext,
    });
    // Never expected from the rule table, which normalises as it goes. Logged
    // rather than swallowed so that if it ever fires, the producer that made a
    // distribution which is not one is named in a log line.
    if (hypothesis.renormalised) {
      logger.warn({ topFault: hypothesis.topFault }, 'fault distribution had to be renormalised');
    }

    const extractionId = await storeExtraction(prismaBase, {
      rawText: body.text,
      outcome,
      confidence: hypothesis.faultDistribution[hypothesis.topFault],
    });

    res.json({
      degraded: false,
      reason: null,
      extractionId,
      symptoms: outcome.symptoms,
      safety: outcome.safety,
      evidence: outcome.extraction.evidence,
      latencyMs: outcome.totalLatencyMs,
      hypothesis,
    });
  },
);

intakeRouter.post('/jobs/intake', authenticate, requirePermission('create', 'job'), async (req, res) => {
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

  // THE SAME RULE THE PICKER USES. `vehicleFilingFilter` is the one place that
  // says which vehicles a driver may file against; `GET /vehicles` composes it
  // into the list it offers, so a vehicle that reaches here from that list
  // cannot be refused. Written literally in both places once, which is how the
  // list came to offer a car this check then rejected.
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: body.vehicleId, ...vehicleFilingFilter(driver.id) },
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
      rawText: body.rawText ?? null,
      extractionId: body.extractionId ?? null,
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

intakeRouter.get('/jobs/:id/next-question', authenticate, requirePermission('read', 'job'), async (req, res) => {
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

intakeRouter.post('/jobs/:id/answers', authenticate, requirePermission('create', 'job'), async (req, res) => {
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
