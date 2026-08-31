// CHAT, AND THE PROMOTIONS IT RAISES.
//
// GET  /jobs/:id/messages          the durable history
// POST /jobs/:id/messages          say something, share a location, send a photo
// GET  /jobs/:id/promotions        what has been flagged and is waiting on a human
// POST /promotions/:id/confirm     a person decides
//
// AUTHORISATION IS THE SCOPED CLIENT'S, then the policy table's. Every route
// resolves the job through `prisma` first, so tenant scoping and row ownership
// decide who can see the conversation at all — a driver reaches their own job's
// chat, a technician the jobs assigned to them, a dispatcher their tenant's.
// WHO MAY CONFIRM WHICH KIND is a second, different question, answered by
// src/domain/promotionPolicy.ts, because it is about what a person can KNOW
// rather than what they own: a dispatcher owns the job and still cannot see
// whether the driver is standing in traffic.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../infra/db.js';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { postMessage, markDeliveriesSent } from '../chat/messages.js';
import { confirmPromotion } from '../commit/eventPromotions.js';
import { confirmerFor, promptFor } from '../domain/promotionPolicy.js';
import { handleTrigger } from '../commit/redispatch.js';
import {
  publishChatMessage,
  publishPromotion,
  publishPromotionResolved,
} from '../realtime/publish.js';

export const chatRouter = Router();

// A conversation a person can actually read. Not a transcript archive — the
// technician wants the last few exchanges, and anything longer belongs to the
// dispatcher's audit trail rather than a phone.
const MESSAGE_LIMIT = 100;

// One photo, held as a data URI in Postgres. There is no object store in this
// project and inventing one at the edge of a chat phase would be the wrong
// place to start; the cap is what stops that decision becoming expensive. See
// this phase's weaknesses.
const MAX_PHOTO_BYTES = 400_000;

async function visibleJobId(id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  const job = await prisma.job.findFirst({ where: { id }, select: { id: true } });
  return job?.id ?? null;
}

// ---------------------------------------------------------------------------

chatRouter.get(
  '/jobs/:id/messages',
  authenticate,
  requirePermission('read', 'chatMessage'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const conversation = await prismaBase.conversation.findUnique({
      where: { jobId },
      select: { id: true },
    });
    if (!conversation) {
      res.json({ jobId, messages: [] });
      return;
    }

    const messages = await prismaBase.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { eventTime: 'asc' },
      take: MESSAGE_LIMIT,
      select: {
        id: true,
        senderRole: true,
        body: true,
        kind: true,
        eventTime: true,
        attachments: { select: { kind: true, url: true } },
      },
    });

    res.json({
      jobId,
      messages: messages.map((message) => ({
        messageId: message.id,
        // THE SENDER'S ROLE, AND NOT THEIR ID. A driver has no business
        // knowing a technician's user id, and "did I send this" is the only
        // question the UI asks — which the role answers, because a conversation
        // has one driver and one technician.
        //
        // It is also the only answer a SOCKET message can carry: that payload
        // goes to a room, so the server cannot stamp "this one is yours" per
        // recipient. Sending `mine` over HTTP and not over the socket is how
        // the driver's own message came back labelled "Driver" a moment after
        // it said "You" — one fact with two sources, disagreeing.
        senderRole: message.senderRole,
        body: message.body,
        kind: message.kind,
        at: message.eventTime.toISOString(),
        photoUrl: message.attachments[0]?.url ?? null,
      })),
    });
  },
);

const postSchema = z
  .object({
    body: z.string().min(1).max(2000),
    kind: z.enum(['TEXT', 'LOCATION', 'PHOTO']).default('TEXT'),
    coordinates: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .optional(),
    photoUrl: z.string().max(MAX_PHOTO_BYTES).optional(),
  })
  .strict();

chatRouter.post(
  '/jobs/:id/messages',
  authenticate,
  requirePermission('create', 'chatMessage'),
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
    const body = postSchema.parse(req.body ?? {});

    const posted = await postMessage(prismaBase, {
      jobId,
      senderRole: auth.role,
      senderId: auth.userId,
      body: body.body,
      kind: body.kind,
      coordinates: body.coordinates,
      photo: body.photoUrl
        ? { url: body.photoUrl, sizeBytes: Buffer.byteLength(body.photoUrl, 'utf8') }
        : undefined,
    });

    // PUBLISH AFTER COMMIT, the same rule the outbox exists to enforce for job
    // events. `postMessage` has returned, so the transaction is done.
    await publishChatMessage({
      messageId: posted.messageId,
      jobId,
      senderRole: auth.role,
      body: body.body,
      kind: body.kind,
      at: new Date().toISOString(),
      photoUrl: body.photoUrl ?? null,
      coordinates: body.coordinates ?? null,
    });
    await markDeliveriesSent(prismaBase, posted.messageId);

    // The flagged cards go out on the same fan-out, so the person who must
    // confirm sees them without polling. NOTHING HAS CHANGED ON THE JOB at
    // this point, and that is the whole design — see eventPromotions.ts.
    const promotions = await loadPromotions(posted.promotionIds);
    for (const promotion of promotions) {
      await publishPromotion(promotion);
    }

    res.status(201).json({
      messageId: posted.messageId,
      // Returned so the sender can see their own message was flagged, rather
      // than a card appearing on somebody else's screen with no explanation.
      promotions,
    });
  },
);

// ---------------------------------------------------------------------------

chatRouter.get(
  '/jobs/:id/promotions',
  authenticate,
  requirePermission('read', 'eventPromotion'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const rows = await prismaBase.eventPromotion.findMany({
      where: { jobId, status: 'FLAGGED' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, jobId: true, kind: true, proposedPayload: true },
    });

    res.json({ jobId, promotions: rows.map(toPromotionView) });
  },
);

const confirmSchema = z.object({ decision: z.enum(['CONFIRMED', 'REJECTED']) }).strict();

chatRouter.post(
  '/promotions/:id/confirm',
  authenticate,
  requirePermission('update', 'eventPromotion'),
  async (req, res) => {
    const auth = req.auth;
    const promotionId = req.params.id;
    if (!auth) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    if (typeof promotionId !== 'string' || promotionId.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = confirmSchema.parse(req.body);

    // The job is resolved through the scoped client FIRST, so a caller who
    // cannot see the job cannot confirm its promotions — RBAC says the role may
    // touch promotions at all, and this says which rows.
    const promotion = await prismaBase.eventPromotion.findUnique({
      where: { id: promotionId },
      select: { jobId: true },
    });
    if (!promotion || !(await visibleJobId(promotion.jobId))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const outcome = await confirmPromotion(prismaBase, {
      promotionId,
      decision: body.decision,
      actor: { role: auth.role, id: auth.actorId ?? null },
    });

    if (outcome.outcome === 'NOT_FOUND') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (outcome.outcome === 'NOT_YOURS') {
      // 403 rather than 404: the caller can see this job and this promotion,
      // so hiding it would be confusing rather than protective. What they
      // cannot do is answer this particular question.
      res.status(403).json({
        error: 'wrong_confirmer',
        confirmer: confirmerFor(outcome.kind),
      });
      return;
    }
    if (outcome.outcome === 'ALREADY_RESOLVED') {
      res.status(409).json({ error: 'already_resolved', status: outcome.status });
      return;
    }

    await publishPromotionResolved(promotion.jobId, {
      promotionId,
      status: body.decision,
    });

    if (outcome.outcome === 'REJECTED') {
      res.json({ promotionId, status: 'REJECTED', applied: false });
      return;
    }

    // THE RE-SOLVE, AFTER THE TRANSACTION. `handleTrigger` opens transactions
    // of its own and runs a whole solve; doing it inside the confirmation
    // would hold that transaction open across it.
    let redispatch = null;
    if (outcome.trigger) {
      redispatch = await handleTrigger(prismaBase, {
        jobId: outcome.jobId,
        trigger: outcome.trigger,
        detail: `confirmed from a message: ${outcome.kind.toLowerCase().replace('_', ' ')}`,
        actor: { role: auth.role, id: auth.actorId ?? null },
      });

      // NO NOTIFICATION IS SENT HERE, deliberately. `handleTrigger` raises a
      // RECOMMEND; nothing about the driver's crew has changed until a
      // dispatcher takes it. The one message per re-plan is enqueued at the
      // moment the plan actually changes — see executeReassignment.
    }

    res.json({
      promotionId,
      status: 'CONFIRMED',
      applied: true,
      kind: outcome.kind,
      jobEventId: outcome.jobEventId,
      trigger: outcome.trigger,
      redispatch,
    });
  },
);

// ---------------------------------------------------------------------------

type PromotionRow = {
  id: string;
  jobId: string;
  kind: string;
  proposedPayload: unknown;
};

// The card a person is shown. The prompt comes from the policy table so the
// wording of a question and the rule about who is asked it cannot drift apart.
function toPromotionView(row: PromotionRow) {
  const kind = row.kind as Parameters<typeof promptFor>[0];
  const prompt = promptFor(kind);
  const payload = (row.proposedPayload ?? {}) as { matched?: string[] };

  return {
    promotionId: row.id,
    jobId: row.jobId,
    kind: row.kind,
    confirmer: confirmerFor(kind),
    question: prompt.question,
    because: prompt.because,
    yes: prompt.yes,
    no: prompt.no,
    // WHY THIS WAS FLAGGED, shown to whoever is deciding. A confirmation
    // screen that will not say what triggered it is one people learn to
    // dismiss without reading.
    matched: payload.matched ?? [],
  };
}

async function loadPromotions(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await prismaBase.eventPromotion.findMany({
    where: { id: { in: ids } },
    select: { id: true, jobId: true, kind: true, proposedPayload: true },
  });
  return rows.map(toPromotionView);
}
