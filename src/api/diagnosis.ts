// POST /jobs/:id/diagnosis — the technician arrives and the job is not what
// intake believed.
//
// This is the signature flow. Everything before it is the system's guess from
// a phone call; this is the first time somebody has actually looked at the
// vehicle. The belief is replaced, the required capabilities are recomputed,
// and then one question decides everything: CAN THE CREW WHO IS ALREADY THERE
// STILL FIX IT?
//
//   YES → nothing moves. The ETA is updated and the driver is told, in a
//         sentence. That is an AUTO action: nobody wants to approve telling a
//         customer their van is still coming.
//   NO  → re-solve. The technician standing at the roadside is either useful
//         to the new plan (they stay) or they are not (they are explicitly
//         released) — never left holding a job the system has quietly moved.
//
// Every branch writes JobEvents, which is what drives the driver's live view:
// the socket replays this table, so "the driver's screen updates" and "the
// event was written" are the same fact.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { classifySymptoms } from '../domain/faultRules.js';
import { requiredCapabilities } from '../domain/capabilitySet.js';
import { recordHypothesis } from '../intake/hypothesis.js';
import { appendJobEvent } from '../intake/events.js';
import { requestAction } from '../commit/actionRequests.js';
import { handleTrigger } from '../commit/redispatch.js';
import { symptomPayloadSchema } from '../domain/symptoms.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export const diagnosisRouter = Router();

const diagnosisSchema = z
  .object({
    symptoms: symptomPayloadSchema,
    note: z.string().max(500).optional(),
  })
  .strict();

diagnosisRouter.post(
  '/jobs/:id/diagnosis',
  authenticate,
  requirePermission('update', 'jobDiagnosis'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }

    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    // Resolved through the SCOPED client, so a technician who cannot see the
    // job gets a 404 before anything is written — the same 404-not-403 rule
    // every other route follows.
    const visible = await prisma.job.findFirst({
      where: { id },
      select: { id: true, assignedUnitId: true, assignedTechnicianId: true },
    });
    if (!visible) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = diagnosisSchema.parse(req.body);

    // The new belief, from what the technician can actually see. Same
    // classifier intake uses — a second one would drift.
    const distribution = classifySymptoms(body.symptoms);
    const required = requiredCapabilities(distribution);

    await runPublishingTransaction(prismaBase, async (tx) => {
      await recordHypothesis(tx, visible.id, distribution);
      await appendJobEvent(tx, {
        jobId: visible.id,
        eventType: 'DIAGNOSIS_CHANGED',
        payload: { required, note: body.note ?? null },
        actorRole: auth.role,
        actorId: auth.actorId ?? null,
      });
    });

    const stillCapable = await assignedCrewCanResolve(visible, required);

    if (stillCapable) {
      // The crew on scene can handle it. Update the ETA and tell the driver —
      // AUTO, because a human asked to approve this would always say yes.
      await requestAction(prismaBase, {
        jobId: visible.id,
        kind: 'NOTIFY_DIAGNOSIS_CONFIRMED',
        reason: 'diagnosis changed; the assigned crew can still resolve it',
        impact: { required },
        actor: { role: auth.role, id: auth.actorId ?? null },
      });
      res.json({ jobId: visible.id, required, reassigned: false });
      return;
    }

    // The crew cannot. Re-solve — which raises a RECOMMEND if a better
    // assignment exists, and escalates if this job has thrashed.
    const outcome = await handleTrigger(prismaBase, {
      jobId: visible.id,
      trigger: 'DIAGNOSIS_CHANGED',
      detail: `on-site diagnosis needs ${required.join(', ') || 'no capability'}`,
      actor: { role: auth.role, id: auth.actorId ?? null },
    });

    // WAITS OR IS RELEASED — told to the technician who just filed this
    // diagnosis, in the response to their own request, rather than left for
    // them to infer from a status code. The release itself happens when the
    // dispatcher executes the reassignment (see executeReassignment); until
    // then they are still the assignment and should stay put.
    const technicianOutcome = await currentCrewOutcome(prismaBase, outcome);

    res.json({ jobId: visible.id, required, reassigned: true, technicianOutcome, outcome });
  },
);

// Can the unit AND technician already assigned to this job resolve the new
// required set? Both halves matter: the van carries tools, the technician
// carries certifications, and a pair can only do what BOTH can do — the same
// intersection candidates.ts computes when it builds an option.
async function assignedCrewCanResolve(
  job: { assignedUnitId: string | null; assignedTechnicianId: string | null },
  required: string[],
): Promise<boolean> {
  if (!job.assignedUnitId || !job.assignedTechnicianId) return false;
  if (required.length === 0) return true;

  const [unit, technician] = await Promise.all([
    prismaBase.unit.findUnique({
      where: { id: job.assignedUnitId },
      select: { capabilities: { select: { capability: { select: { code: true } } } } },
    }),
    prismaBase.technician.findUnique({
      where: { id: job.assignedTechnicianId },
      select: { capabilities: { select: { capability: { select: { code: true } } } } },
    }),
  ]);
  if (!unit || !technician) return false;

  const unitCodes = new Set(unit.capabilities.map((link) => link.capability.code));
  const technicianCodes = new Set(technician.capabilities.map((link) => link.capability.code));

  return required.every((code) => unitCodes.has(code) && technicianCodes.has(code));
}

// What the on-site technician should do next, in one word plus a sentence.
// Read from the action the re-solve raised rather than recomputed, so the page
// the technician sees and the action the dispatcher sees cannot disagree.
async function currentCrewOutcome(
  db: typeof prismaBase,
  outcome: Awaited<ReturnType<typeof handleTrigger>>,
): Promise<{ status: 'WAIT' | 'RELEASE_PENDING'; detail: string }> {
  if (outcome.outcome !== 'REASSIGNMENT_PROPOSED') {
    return {
      status: 'WAIT',
      detail: 'no better crew was found; stay with this job',
    };
  }

  const action = await db.actionRequest.findUnique({
    where: { id: outcome.actionRequestId },
    select: { computedImpact: true },
  });
  const impact = action?.computedImpact as { technicianRetained?: boolean } | null;

  return impact?.technicianRetained
    ? { status: 'WAIT', detail: 'the new plan still uses this crew; stay with this job' }
    : {
        status: 'RELEASE_PENDING',
        detail:
          'a better-equipped crew has been proposed; you will be released when a dispatcher confirms it',
      };
}
