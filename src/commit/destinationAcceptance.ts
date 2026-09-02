// RECORDING WHAT A WORKSHOP ACTUALLY DID — the write half of the learned
// P(accept).
//
// src/domain/workshopAcceptance.ts decides which (hour bucket, vehicle
// class) cell a moment belongs to and how to turn counts into a probability;
// this is the one place a real outcome becomes a row in that count. Every
// solve that touches a tow job reads what this file writes, by the dozen —
// src/commit/dispatchSnapshot.ts groups the whole table once per run.
//
// CALLED FROM TWO PLACES, both after the SAME conditional update has already
// decided the destination offer's fate: src/commit/saga.ts's
// `recordDestinationDecision` (ACCEPTED or DECLINED, a workshop answering)
// and src/workers/offerExpiry.ts (TIMEOUT, nobody answering before the same
// deadline the technician offer shares). Neither calls this speculatively —
// each only calls it once it already knows the transition it is recording
// actually happened, which is what keeps this a plain `create` rather than
// needing its own idempotency guard: `destination_offer_id` is unique on the
// table, and only the writer that won the race gets this far.

import type { PrismaClient } from '@prisma/client';
import { hourBucketFor, vehicleClassFor } from '../domain/workshopAcceptance.js';

export type DestinationAcceptanceOutcome = 'ACCEPTED' | 'DECLINED' | 'TIMEOUT';

export async function recordAcceptanceOutcome(
  db: PrismaClient,
  input: {
    destinationOfferId: string;
    jobId: string;
    workshopId: string;
    outcome: DestinationAcceptanceOutcome;
    at: Date;
  },
): Promise<void> {
  // THE ONE FACT THIS FILE NEEDS THAT THE CALLER DOES NOT ALREADY HAVE: what
  // kind of vehicle this was, for the (workshop, hour, class) cell. Read
  // fresh rather than threaded through from wherever the saga started,
  // because a workshop's answer can arrive minutes after dispatch — the
  // vehicle has not changed, but re-deriving it here means this file has one
  // dependency (the job id) rather than trusting a caller to have carried the
  // right snapshot value all the way through a saga.
  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: { vehicle: { select: { profile: { select: { evClass: true } } } } },
  });

  await db.acceptanceOutcome.create({
    data: {
      destinationOfferId: input.destinationOfferId,
      workshopId: input.workshopId,
      outcome: input.outcome,
      hourBucket: hourBucketFor(input.at),
      vehicleClass: vehicleClassFor(job?.vehicle.profile.evClass ?? null),
      recordedAt: input.at,
    },
  });
}
