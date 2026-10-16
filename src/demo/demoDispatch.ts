// TWO GAPS THE DEMO NEEDS CLOSED — only with DEMO_MODE on.
//
// Reserving a crew happens in exactly one place: a dispatcher executing a
// REASSIGN_* card (src/commit/redispatch.ts, executeReassignment). A card is
// raised by a re-plan trigger. Two moments in the demo script had no trigger:
//
//   1. A job the driver just reported. Intake finishes and the job sits in the
//      queue; nothing re-plans it, so no card appears and crew B never gets an
//      offer. (Outside the demo the reservation comes from a driver's safety
//      message — see DEMO.md history — or a diagnosis change.)
//   2. A job a technician just declined or let time out. The saga unwinds and
//      raises "nobody is assigned and it will not move on its own"
//      (src/commit/saga.ts) — and if anything did re-plan it, the solver would
//      pick the same technician again, because nothing about them changed.
//
// Both are closed by firing an ordinary trigger through the ordinary
// handleTrigger, so the dispatcher still sees a RECOMMEND card and still
// presses Execute: the human step stays human. Gated on DEMO_MODE so every
// other deployment behaves exactly as before.

import type { PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { handleTrigger } from '../commit/redispatch.js';
import type { RedispatchOutcome } from '../commit/redispatch.js';

// After intake: re-plan the job so a dispatch card naming the best crew lands
// in the dispatcher's action queue. Never throws — a failed re-plan must not
// turn a successfully reported breakdown into an error on the driver's phone;
// it is logged, and the job is still in the queue for a manual solve.
export async function dispatchAfterIntake(db: PrismaClient, jobId: string): Promise<RedispatchOutcome | null> {
  if (!config.demoMode) return null;
  try {
    return await handleTrigger(db, {
      jobId,
      trigger: 'INTAKE_COMPLETED',
      detail: 'intake complete: ready to dispatch',
    });
  } catch (error) {
    logger.error({ err: error, jobId }, 'demo dispatch after intake failed');
    return null;
  }
}

// After a refusal: re-plan without every technician who has refused this job,
// so the card names the next-best crew rather than the one who just said no.
export async function redispatchAfterRefusal(
  db: PrismaClient,
  jobId: string,
): Promise<RedispatchOutcome | null> {
  if (!config.demoMode) return null;
  try {
    const refused = await db.technicianOffer.findMany({
      where: { jobId, status: { in: ['DECLINED', 'TIMEOUT'] } },
      select: { technicianId: true, status: true },
    });
    const technicianIds = [...new Set(refused.map((offer) => offer.technicianId))];
    return await handleTrigger(db, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      detail: `offer ${refused.at(-1)?.status.toLowerCase() ?? 'refused'}: re-planned without the crew that refused`,
      excludeTechnicianIds: technicianIds,
    });
  } catch (error) {
    logger.error({ err: error, jobId }, 'demo re-dispatch after refusal failed');
    return null;
  }
}
