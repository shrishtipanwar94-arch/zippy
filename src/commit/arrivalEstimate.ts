// A REAL ETA, RECORDED — "arriving 21:24", not a countdown.
//
// The phase brief asks for "live tracking with a real ETA, not a countdown
// timer", and the difference is not cosmetic. A countdown is computed once and
// then decays on the client whatever happens on the road; when the technician
// hits traffic it stalls at "2 minutes" for a quarter of an hour and reads as
// a broken promise. A clock time is a fact recomputed from where the unit
// actually is, and when it moves the driver learns something true.
//
// So the ETA is a ROW, not a client-side timer: every recomputation appends an
// `eta_estimates` row and a JobEvent, the driver's page re-reads the latest,
// and the history of what we told them is auditable afterwards.
//
// WHY THIS IS NOT AN INVARIANT 10 PROBLEM. Invariant 10 forbids an external
// service inside a dispatch DECISION — the solver, feasibility, the cost
// function. This is none of those: it is a driver-facing read computed after
// the decision is made, and it runs against the same self-hosted OSRM
// everything else uses, which is local and deterministic anyway.
//
// IT MUST NEVER FAIL ITS CALLER. Being unable to say when somebody will arrive
// is a worse status page; failing the technician's "on my way" tap because a
// routing container is down is a broken dispatch. Routing already degrades to
// a haversine estimate rather than throwing, and the `degraded` flag is stored
// so an operator can see that the number on the driver's screen is a rough one
// (invariant 8).

import type { PrismaClient } from '@prisma/client';
import { travelTime } from '../infra/routing.js';
import { appendJobEvent } from '../intake/events.js';
import { logger } from '../infra/logger.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export type ArrivalEstimate = {
  etaSeconds: number;
  arrivingAt: Date;
  degraded: boolean;
};

export async function recordArrivalEstimate(
  db: PrismaClient,
  jobId: string,
): Promise<ArrivalEstimate | null> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      lat: true,
      lng: true,
      assignedTechnicianId: true,
      assignedUnit: { select: { id: true, lat: true, lng: true } },
    },
  });

  // No assigned unit, or a unit that has never reported a position. Saying
  // nothing is the honest answer; the driver's page then shows "on the way"
  // with no time rather than a number nobody computed.
  const unit = job?.assignedUnit;
  if (!job || job.lat === null || job.lng === null) return null;
  if (!unit || unit.lat === null || unit.lng === null) return null;

  const estimate = await travelTime(
    { lat: unit.lat, lng: unit.lng },
    { lat: job.lat, lng: job.lng },
  );

  const etaSeconds = Math.round(estimate.minutes * 60);
  const arrivingAt = new Date(Date.now() + etaSeconds * 1000);

  await runPublishingTransaction(db, async (tx) => {
    await tx.etaEstimate.create({
      data: {
        jobId: job.id,
        unitId: unit.id,
        technicianId: job.assignedTechnicianId,
        etaSeconds,
        method: estimate.method,
        degraded: estimate.degraded,
      },
    });
    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'ETA_UPDATED',
      payload: { etaSeconds, degraded: estimate.degraded, method: estimate.method },
    });
  });

  return { etaSeconds, arrivingAt, degraded: estimate.degraded };
}

// The caller almost always wants "record it if you can, and carry on either
// way". Wrapped once here rather than in a try/catch at each call site, so no
// route can accidentally make the driver's ETA a hard dependency of a
// technician's action.
export async function recordArrivalEstimateQuietly(
  db: PrismaClient,
  jobId: string,
): Promise<void> {
  try {
    await recordArrivalEstimate(db, jobId);
  } catch (error) {
    logger.warn({ err: error, jobId }, 'could not record an arrival estimate');
  }
}
