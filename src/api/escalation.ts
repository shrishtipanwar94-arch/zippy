// GET  /jobs/:id/escalation      why this job has no plan, and what to do
// POST /jobs/:id/escalation      the dispatcher's decision, recorded
//
// THE CARD IS BUILT FROM THE LAST SOLVER RUN'S OWN REJECTIONS, not from a
// fresh solve. Two reasons, and the second is the important one:
//   - a solve is expensive and this is a page load;
//   - the dispatcher must see the reasons behind the decision that actually
//     happened. Re-solving would answer a slightly different question — "what
//     would happen if we tried now" — and quietly disagree with the timeline
//     the operator is looking at.
//
// A DECISION IS A WRITE, and it goes through the Escalation/EscalationDecision
// tables Phase 1 created rather than a status column: "we sent an external
// provider at 15:42 because no crew held the capability" is a sentence the
// audit trail has to be able to reproduce.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { visibleJobId } from './visibleJob.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { buildEscalationCard } from '../domain/escalationCard.js';
import type { RejectedOptionView } from '../domain/escalationCard.js';
import type { RejectionCode } from '../engine/feasibility.js';

export const escalationRouter = Router();

const decisionSchema = z.object({
  decision: z.enum(['APPROVE_ANYWAY', 'FIND_EXTERNAL_PROVIDER', 'CONTACT_DRIVER']),
  note: z.string().max(500).nullable().default(null),
});


escalationRouter.get(
  '/jobs/:id/escalation',
  authenticate,
  requirePermission('read', 'solverRun'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // The most recent run that actually looked at this job. A run that never
    // considered it says nothing about why it has no plan.
    const lastOption = await prismaBase.dispatchOption.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      select: { solverRunId: true },
    });

    if (!lastOption) {
      res.json({ jobId, planned: false, card: buildEscalationCard(jobId, []) });
      return;
    }

    const options = await prismaBase.dispatchOption.findMany({
      where: { jobId, solverRunId: lastOption.solverRunId, feasible: false },
      select: {
        unitId: true,
        rejectionCode: true,
        rejectionDetail: true,
        estimatedTravelMinutes: true,
        missingCapabilities: true,
        // The technician's name lives on their user row, not on the technician
        // row — an escalation card that said "tech-14" would be exactly the
        // blank-screen failure this card exists to replace.
        unit: {
          select: {
            code: true,
            currentTechnician: { select: { user: { select: { name: true } } } },
          },
        },
      },
    });

    const rejections: RejectedOptionView[] = options.map((option) => ({
      unitId: option.unitId,
      unitCode: option.unit.code,
      technicianName: option.unit.currentTechnician?.user.name ?? null,
      // The column is a plain string because the database has no reason to
      // know the engine's union; it was written from that union one solve ago.
      code: (option.rejectionCode ?? 'UNIT_UNAVAILABLE') as RejectionCode,
      detail: option.rejectionDetail ?? 'no detail recorded',
      travelMinutes: option.estimatedTravelMinutes,
      missingCapabilities: option.missingCapabilities,
    }));

    res.json({ jobId, planned: false, card: buildEscalationCard(jobId, rejections) });
  },
);

escalationRouter.post(
  '/jobs/:id/escalation',
  authenticate,
  requirePermission('update', 'actionRequest'),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }

    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = decisionSchema.parse(req.body ?? {});

    // One OPEN escalation per job: a second dispatcher opening the card while
    // the first is deciding must land on the same row, not start a parallel
    // one. Read-then-create rather than an upsert because `escalations` has no
    // unique key on (job_id, status) — the loser of a race writes a second
    // decision onto whichever row it read, which is a duplicated note rather
    // than a split history.
    const existing = await prismaBase.escalation.findFirst({
      where: { jobId, status: 'OPEN' },
      select: { id: true },
    });
    const escalationId =
      existing?.id ??
      (
        await prismaBase.escalation.create({
          data: { jobId, reason: 'NO_FEASIBLE_PLAN' },
          select: { id: true },
        })
      ).id;

    await prismaBase.escalationDecision.create({
      data: {
        escalationId,
        decision: body.decision,
        note: body.note,
        decidedByRole: auth.role,
        decidedById: auth.userId,
      },
    });

    // CONTACT_DRIVER is the one decision that does not end the escalation —
    // the dispatcher is going to come back with what the driver said.
    if (body.decision !== 'CONTACT_DRIVER') {
      await prismaBase.escalation.updateMany({
        where: { id: escalationId, status: 'OPEN' },
        data: { status: 'RESOLVED', closedAt: new Date() },
      });
    }

    res.status(201).json({ escalationId, decision: body.decision });
  },
);
