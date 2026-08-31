// THE TECHNICIAN'S THREE ENDPOINTS.
//
// GET  /technician/work              open offers, and the job in hand
// POST /technician/offers/:id/respond  accept or decline, with a live deadline
// POST /jobs/:id/actions             one rung of the status ladder
//
// The split between the last two is the phase's offline story in one line.
// A ladder action is queued on the phone with a key the phone generated and
// replayed on reconnect, so `/jobs/:id/actions` is idempotent by construction
// (src/commit/technicianActions.ts). An OFFER cannot work that way: it has a
// forty-five-second deadline, so answering it from a queue that drains ten
// minutes later would accept a job somebody else has long since been sent to.
// It is online-only, deliberately, and the page says so rather than silently
// dropping the tap.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { recordTechnicianDecision } from '../commit/saga.js';
import { applyTechnicianAction } from '../commit/technicianActions.js';
import { recordArrivalEstimateQuietly } from '../commit/arrivalEstimate.js';
import { authoriseCalloutQuietly, captureOnCompletionQuietly } from '../commit/payments.js';
import { recordJobCompletionQuietly } from '../commit/earnings.js';
import { LADDER_STEPS, nextStepFor } from '../domain/jobLadder.js';

export const technicianRouter = Router();

// The statuses a technician still has work to do on. A RESOLVED or CANCELLED
// job drops off their screen; the dispatcher keeps it.
//
// AWAITING_APPROVAL IS ON THIS LIST even though the technician cannot advance
// it. A paused job is still theirs — they are standing next to the car — and
// dropping it off the board would tell them it had been taken away. What they
// see instead is why it is stopped and who it is waiting on.
const OPEN_STATUSES = [
  'COMMITTED',
  'EN_ROUTE',
  'ON_SITE',
  'DIAGNOSING',
  'WORKING',
  'AWAITING_APPROVAL',
] as const;

// Gated on `technicianAction`, not on `job`. A DRIVER may `read` `job` — it is
// how they see their own incident — so guarding this board on `job` let a
// driver call it and get an empty 200. Empty is not a leak, but a 200 on
// somebody else's surface is the wrong answer; only the role this board
// belongs to should reach it.
technicianRouter.get(
  '/technician/work',
  authenticate,
  requirePermission('read', 'technicianAction'),
  async (req, res) => {
    const technicianId = req.auth?.actorId;
    if (!technicianId) {
      // A TECHNICIAN token with no Technician row. Fails closed with an empty
      // board rather than falling back to "every job", the same rule NO_OWNER
      // follows in the permission layer.
      res.json({ offers: [], jobs: [] });
      return;
    }

    const [offers, jobs] = await Promise.all([
      prismaBase.technicianOffer.findMany({
        where: { technicianId, status: 'PROPOSED', expiresAt: { gt: new Date() } },
        orderBy: { sentAt: 'asc' },
        select: {
          id: true,
          expiresAt: true,
          job: {
            select: {
              id: true,
              safetyLevel: true,
              landmark: true,
              roadPosition: true,
              zone: { select: { name: true } },
              vehicle: { select: { registration: true, profile: { select: { make: true, model: true } } } },
            },
          },
        },
      }),
      prismaBase.job.findMany({
        where: { assignedTechnicianId: technicianId, status: { in: [...OPEN_STATUSES] } },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          safetyLevel: true,
          lat: true,
          lng: true,
          landmark: true,
          zone: { select: { name: true } },
          vehicle: { select: { registration: true, profile: { select: { make: true, model: true } } } },
        },
      }),
    ]);

    res.json({
      offers: offers.map((offer) => ({
        offerId: offer.id,
        jobId: offer.job.id,
        // The deadline as an instant, never a countdown from the server: the
        // page derives seconds remaining from this and its own clock, so a
        // slow response shows a shorter countdown rather than a wrong one.
        expiresAt: offer.expiresAt.toISOString(),
        safetyLevel: offer.job.safetyLevel,
        zone: offer.job.zone.name,
        where: offer.job.landmark ?? offer.job.roadPosition ?? null,
        vehicle: describeVehicle(offer.job.vehicle),
      })),
      jobs: jobs.map((job) => ({
        jobId: job.id,
        status: job.status,
        nextStep: nextStepFor(job.status),
        safetyLevel: job.safetyLevel,
        zone: job.zone.name,
        landmark: job.landmark,
        lat: job.lat,
        lng: job.lng,
        vehicle: describeVehicle(job.vehicle),
      })),
    });
  },
);

function describeVehicle(
  vehicle: { registration: string; profile: { make: string; model: string } | null } | null,
): string {
  if (!vehicle) return 'unknown vehicle';
  const profile = vehicle.profile;
  return profile ? `${profile.make} ${profile.model} · ${vehicle.registration}` : vehicle.registration;
}

// ---------------------------------------------------------------------------

const respondSchema = z.object({ decision: z.enum(['ACCEPTED', 'DECLINED']) }).strict();

technicianRouter.post(
  '/technician/offers/:id/respond',
  authenticate,
  requirePermission('update', 'technicianAction'),
  async (req, res) => {
    const technicianId = req.auth?.actorId;
    const offerId = req.params.id;
    if (!technicianId) {
      res.status(403).json({ error: 'not_a_technician' });
      return;
    }
    if (typeof offerId !== 'string' || offerId.length === 0) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const body = respondSchema.parse(req.body);

    // Scoped by technician here rather than by an extension: offers are not
    // jobs, so the row-ownership extension does not narrow them. Another
    // technician's offer id resolves to nothing and gets a 404.
    const offer = await prismaBase.technicianOffer.findFirst({
      where: { id: offerId, technicianId },
      select: { id: true, jobId: true, dispatchOfferId: true, status: true },
    });
    if (!offer) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!offer.dispatchOfferId) {
      res.status(409).json({ error: 'offer_not_part_of_a_reservation' });
      return;
    }

    // The saga owns this transition — it decides whether all legs are in and
    // whether the reservation commits. Answering the offer row directly here
    // would leave the saga waiting on a leg that has already been answered.
    const state = await recordTechnicianDecision(prismaBase, {
      sagaId: offer.dispatchOfferId,
      decision: body.decision,
    });

    // An accept that committed the reservation is the first moment we can say
    // when this driver will be reached. Never allowed to fail the response.
    if (state === 'COMMITTED') {
      await recordArrivalEstimateQuietly(prismaBase, offer.jobId);
      // STAGE ONE OF THE TWO-STAGE SPLIT: the callout fee, and nothing else,
      // because nobody yet knows what the repair costs. `Quietly` is the whole
      // invariant — a stranded driver does not wait for a card to clear, so a
      // failed authorisation flags itself and the job commits regardless.
      await authoriseCalloutQuietly(prismaBase, offer.jobId);
    }

    res.json({ offerId: offer.id, jobId: offer.jobId, sagaState: state });
  },
);

// ---------------------------------------------------------------------------
// ONE RUNG OF THE LADDER — the endpoint the offline queue drains into.

const actionSchema = z
  .object({
    // Generated by the phone at the moment of the tap. The server never mints
    // one: a key the server invents is a new key on every retry, which is the
    // one thing an idempotency key must not be.
    idempotencyKey: z.string().min(8).max(100),
    step: z.enum(LADDER_STEPS),
    clientSequence: z.number().int().min(0),
    // When the technician tapped, which during an outage is minutes before we
    // hear about it.
    eventTime: z.iso.datetime(),
    completionCode: z.string().min(1).max(20).optional(),
  })
  .strict();

technicianRouter.post(
  '/jobs/:id/actions',
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
    const body = actionSchema.parse(req.body);

    const result = await applyTechnicianAction(prismaBase, {
      jobId,
      technicianId,
      idempotencyKey: body.idempotencyKey,
      step: body.step,
      clientSequence: body.clientSequence,
      eventTime: new Date(body.eventTime),
      completionCode: body.completionCode,
    });

    // Setting off is the second moment an ETA becomes worth recomputing — the
    // unit is now actually moving, and the number the driver is looking at was
    // computed when the offer was accepted.
    if (result.outcome === 'APPLIED' && body.step === 'EN_ROUTE') {
      await recordArrivalEstimateQuietly(prismaBase, jobId);
    }

    // THE CODE IS WHAT RELEASES THE MONEY. Not a status change, not a
    // dispatcher pressing something: the driver reads a code off their phone
    // and the technician types it, so the capture is triggered by the one
    // signal that comes from the CUSTOMER's side of the transaction. Quietly,
    // because the work is done and the job is complete either way — a failed
    // capture is money to chase, not a reason to refuse to finish a job.
    if (result.outcome === 'APPLIED' && body.step === 'COMPLETE') {
      await captureOnCompletionQuietly(prismaBase, jobId);
      // AND THE BOOKS. The capture moves the money; this records who earned
      // what. Separate calls because they fail independently — a gateway being
      // down does not mean the technician did not earn their share, and the
      // ledger records what is OWED rather than what has physically moved.
      await recordJobCompletionQuietly(prismaBase, jobId);
    }

    // EVERY OUTCOME IS 200, INCLUDING REJECTED. A queued action is replayed
    // until the server answers, so a 4xx would mean the phone either retries a
    // rejection forever or drops actions it should not. The status code says
    // "your queue item was processed"; the body says what it meant.
    res.json({ jobId, step: body.step, ...result });
  },
);
