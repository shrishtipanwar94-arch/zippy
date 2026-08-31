// THE ESTIMATE'S TWO SIDES.
//
// POST /jobs/:id/estimate      the technician prices what they found
// GET  /jobs/:id/estimate      the current estimate, itemised
// POST /estimates/:id/respond  the driver approves, declines, or cancels
//
// WHO MAY DO WHAT is split across two resources on purpose. `estimate` is
// created by the person holding the spanner and read by everyone on the job;
// `estimateApproval` is updated by the person who pays. A technician who could
// approve their own estimate is not a re-approval loop, it is a formality —
// the whole value of the pause is that somebody else has to say yes.
//
// The job is always resolved through the SCOPED client first, so tenant
// scoping and row ownership decide who can see it at all: a driver reaches
// their own job, a technician the jobs assigned to them, a dispatcher their
// tenant's.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { buildEstimate } from '../commit/estimates.js';
import { respondToEstimate } from '../commit/estimateResponses.js';
import { formatRupees } from '../domain/money.js';

export const estimatesRouter = Router();

async function visibleJobId(id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  const job = await prisma.job.findFirst({ where: { id }, select: { id: true } });
  return job?.id ?? null;
}

const buildSchema = z
  .object({
    // Only supplied when the job actually needs moving. A tow is metered and
    // nothing invents a distance — see commit/estimates.ts.
    towKilometres: z.number().positive().max(2000).optional(),
  })
  .strict();

estimatesRouter.post(
  '/jobs/:id/estimate',
  authenticate,
  requirePermission('create', 'estimate'),
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
    const body = buildSchema.parse(req.body ?? {});

    const result = await buildEstimate(prismaBase, {
      jobId,
      towKilometres: body.towKilometres,
      actor: { role: auth.role, id: auth.actorId ?? null },
    });

    if (result.outcome === 'NOT_FOUND') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result.outcome === 'CANNOT_PRICE') {
      // 409, not 500. A job with no pinned price list is a degraded state the
      // system deliberately allows (stage 1 does not block intake on a
      // catalogue), so it is an answer rather than a failure.
      res.status(409).json({ error: 'cannot_price', reason: result.reason });
      return;
    }
    if (result.outcome === 'ALREADY_AWAITING') {
      res.status(409).json({ error: 'already_awaiting_approval', estimateId: result.estimateId });
      return;
    }

    res.status(201).json(result);
  },
);

estimatesRouter.get(
  '/jobs/:id/estimate',
  authenticate,
  requirePermission('read', 'estimate'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const estimate = await prismaBase.estimate.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        totalPaise: true,
        createdAt: true,
        lines: {
          select: { kind: true, description: true, quantity: true, amountPaise: true },
        },
        approval: { select: { approvedByRole: true, approvedAt: true, channel: true } },
      },
    });
    if (!estimate) {
      res.json({ jobId, estimate: null });
      return;
    }

    res.json({
      jobId,
      estimate: {
        estimateId: estimate.id,
        status: estimate.status,
        total: formatRupees(estimate.totalPaise),
        totalPaise: estimate.totalPaise,
        issuedAt: estimate.createdAt.toISOString(),
        lines: estimate.lines.map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amount: formatRupees(line.amountPaise),
        })),
        // What was approved and when, which is the question a billing dispute
        // is made of.
        approval: estimate.approval
          ? {
              approvedByRole: estimate.approval.approvedByRole,
              approvedAt: estimate.approval.approvedAt.toISOString(),
              channel: estimate.approval.channel,
            }
          : null,
      },
    });
  },
);

const respondSchema = z.object({ decision: z.enum(['APPROVE', 'DECLINE', 'CANCEL']) }).strict();

estimatesRouter.post(
  '/estimates/:id/respond',
  authenticate,
  requirePermission('update', 'estimateApproval'),
  async (req, res) => {
    const auth = req.auth;
    const estimateId = req.params.id;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (typeof estimateId !== 'string' || estimateId.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = respondSchema.parse(req.body);

    // Row scoping: the estimate's JOB must be visible to this caller. RBAC
    // said the role may answer estimates; this says which ones.
    const estimate = await prismaBase.estimate.findUnique({
      where: { id: estimateId },
      select: { jobId: true },
    });
    if (!estimate || !(await visibleJobId(estimate.jobId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const result = await respondToEstimate(prismaBase, {
      estimateId,
      decision: body.decision,
      actor: { role: auth.role, id: auth.actorId ?? null },
      channel: 'APP',
    });

    if (result.outcome === 'NOT_FOUND') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result.outcome === 'ALREADY_ANSWERED') {
      res.status(409).json({ error: 'already_answered', status: result.status });
      return;
    }
    if (result.outcome === 'NOTHING_APPROVED') {
      // Declining the FIRST estimate would leave the job paused with no scope
      // to finish and no way out. The two answers that do make sense are named
      // rather than left for the client to guess.
      res.status(409).json({
        error: 'nothing_approved_to_fall_back_to',
        allowed: ['APPROVE', 'CANCEL'],
      });
      return;
    }

    res.json(result);
  },
);
