// THE ACTION QUEUE — what the system would like to do, and who says yes.
//
// GET  /actions            everything still waiting on a person
// POST /actions/:id/execute  a dispatcher takes a RECOMMEND
// POST /actions/:id/approve  a dispatcher signs off an APPROVE (or rejects)
//
// The two POSTs are separate routes rather than one with a `decision` field
// because they are different acts. Executing a recommendation is doing the
// work the system proposed; approving an escalation is accepting
// responsibility for a call the system explicitly refused to make. Collapsing
// them would make the approval record — who signed this off — optional, and it
// is the entire point of the APPROVE tier.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { isActionKind, needsDecision } from '../domain/actionTiers.js';
import { resolveAction } from '../commit/actionRequests.js';
import { executeReassignment } from '../commit/redispatch.js';

export const actionsRouter = Router();

const REASSIGNMENT_KINDS = ['REASSIGN_AFTER_DIAGNOSIS_CHANGE', 'REASSIGN_AFTER_TRIGGER'];

actionsRouter.get(
  '/actions',
  authenticate,
  requirePermission('read', 'actionRequest'),
  async (_req, res) => {
    const actions = await prismaBase.actionRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        jobId: true,
        tier: true,
        kind: true,
        reason: true,
        computedImpact: true,
        createdAt: true,
      },
    });

    // GROUPED BY WHETHER SOMEBODY HAS TO DECIDE, not by tier. The console
    // renders two lists off this flag; the reasoning for the split is in
    // domain/actionTiers.ts, and it lives there rather than in the panel so
    // there is one answer rather than a server one and a browser one.
    res.json({
      actions: actions.map((action) => ({
        ...action,
        needsDecision: isActionKind(action.kind) ? needsDecision(action.kind) : true,
      })),
    });
  },
);

const noteSchema = z.object({ note: z.string().max(500).optional() }).strict();

actionsRouter.post(
  '/actions/:id/execute',
  authenticate,
  requirePermission('update', 'actionRequest'),
  async (req, res) => {
    const auth = req.auth;
    const id = req.params.id;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    noteSchema.parse(req.body ?? {});

    const action = await prismaBase.actionRequest.findUnique({
      where: { id },
      select: { kind: true, tier: true },
    });
    if (!action) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (action.tier === 'APPROVE') {
      // An APPROVE action is blocked pending sign-off by definition. Letting
      // it be executed here would make the tier decorative.
      res.status(409).json({ error: 'requires_approval' });
      return;
    }

    const resolved = await resolveAction(prismaBase, {
      actionRequestId: id,
      decision: 'EXECUTED',
      approver: { role: auth.role, id: auth.userId },
    });
    if (resolved.outcome === 'ALREADY_RESOLVED') {
      res.status(409).json({ error: 'already_resolved', status: resolved.status });
      return;
    }

    if (!REASSIGNMENT_KINDS.includes(action.kind)) {
      res.json({ actionRequestId: id, executed: true, reserved: false });
      return;
    }

    // THE RESERVATION STARTS HERE. Marking the action executed and starting
    // the saga are ordered deliberately: if the saga's first leg loses its
    // race it ends REQUEUED, and the action is still correctly recorded as
    // executed — the dispatcher did press the button, and what happened next
    // is the saga's story, told in dispatch_offers.
    const saga = await executeReassignment(prismaBase, {
      actionRequestId: id,
      actor: { role: auth.role, id: auth.userId },
    });
    res.json({ actionRequestId: id, executed: true, reserved: saga.outcome === 'SAGA_STARTED', saga });
  },
);

const approveSchema = z
  .object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(500).optional() })
  .strict();

actionsRouter.post(
  '/actions/:id/approve',
  authenticate,
  requirePermission('update', 'actionRequest'),
  async (req, res) => {
    const auth = req.auth;
    const id = req.params.id;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = approveSchema.parse(req.body);

    const resolved = await resolveAction(prismaBase, {
      actionRequestId: id,
      decision: body.decision,
      approver: { role: auth.role, id: auth.userId },
      note: body.note,
    });

    if (resolved.outcome === 'ALREADY_RESOLVED') {
      res.status(409).json({ error: 'already_resolved', status: resolved.status });
      return;
    }
    res.json({ actionRequestId: id, status: resolved.status });
  },
);
