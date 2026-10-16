// KEEP CREW B AVAILABLE: free a demo van that is stuck but not working.
//
// A presenter walks away mid-demo all the time — an offer nobody answered, a
// reservation half made, a job finished in a way that left the van marked
// HELD or ON_JOB. The normal machinery cleans most of that up (the offer-expiry
// worker, the hold sweep in src/workers/cleanup.ts), but both run on Redis
// queues, and a flushed queue or a restart at the wrong moment leaves a van
// that nothing will ever free. On the demo board that van is crew B, and every
// job the presenter creates afterwards would go to D.
//
// So the worker's fifteen-minute demo refresh also runs this, for the four
// demo vans only:
//
//   1. An offer still PROPOSED more than STALE_AFTER_MS after it was sent is
//      timed out through the SAME two calls the offer-expiry worker makes
//      (timeoutOffer, then advanceSaga), so the saga compensates normally:
//      the hold is released and the job requeues. Nothing is invented.
//   2. A hold still ACTIVE more than STALE_AFTER_MS after it was taken, whose
//      reservation has already ended, is released.
//   3. A van not marked AVAILABLE, with no running job and no live hold, is
//      put back to AVAILABLE.
//
// A van with a running job is never touched (invariant 7), and no job row is
// deleted or changed here — step 1 moves a job only by the saga's own path.

import type { PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { timeoutOffer } from '../commit/offers.js';
import { advanceSaga } from '../commit/saga.js';
import { releaseHold } from '../commit/holds.js';
import { findBusyUnitIds } from './busyDemoUnits.js';
import { DEMO_CREWS } from './demoCrews.js';

export const STALE_AFTER_MS = 10 * 60_000;

// Sagas that are over: their holds have nothing left to protect.
const FINISHED_SAGA_STATES = ['COMMITTED', 'RELEASED_ALL', 'REQUEUED'] as const;

export type FreedVans = { offersTimedOut: number; holdsReleased: number; vansFreed: string[] };

async function timeOutStaleOffers(db: PrismaClient, technicianIds: string[], staleBefore: Date): Promise<number> {
  const stale = await db.technicianOffer.findMany({
    where: { technicianId: { in: technicianIds }, status: 'PROPOSED', sentAt: { lt: staleBefore } },
    select: { id: true, dispatchOfferId: true },
  });
  for (const offer of stale) {
    await timeoutOffer(db, { offerId: offer.id });
    if (offer.dispatchOfferId) await advanceSaga(db, offer.dispatchOfferId);
  }
  return stale.length;
}

async function releaseOrphanHolds(db: PrismaClient, unitIds: string[], staleBefore: Date): Promise<number> {
  const stale = await db.unitHold.findMany({
    where: { unitId: { in: unitIds }, status: 'ACTIVE', heldAt: { lt: staleBefore } },
    select: { id: true, dispatchOffer: { select: { state: true } } },
  });
  let released = 0;
  for (const hold of stale) {
    const sagaState = hold.dispatchOffer?.state ?? null;
    const sagaOver = sagaState === null || (FINISHED_SAGA_STATES as readonly string[]).includes(sagaState);
    if (!sagaOver) continue;
    await releaseHold(db, { holdId: hold.id, reason: 'DEMO_CLEANUP: stale hold on a finished reservation' });
    released += 1;
  }
  return released;
}

export async function freeStuckDemoVans(db: PrismaClient, now: Date = new Date()): Promise<FreedVans> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const units = await db.unit.findMany({
    where: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } },
    select: { id: true, code: true, status: true, currentTechnicianId: true },
  });
  const technicianIds: string[] = [];
  for (const unit of units) {
    if (unit.currentTechnicianId) technicianIds.push(unit.currentTechnicianId);
  }
  const unitIds = units.map((unit) => unit.id);

  const offersTimedOut = await timeOutStaleOffers(db, technicianIds, staleBefore);
  const holdsReleased = await releaseOrphanHolds(db, unitIds, staleBefore);

  // Read AFTER the two steps above, which may have just freed something.
  const busy = await findBusyUnitIds(db, unitIds, now);
  const vansFreed: string[] = [];
  for (const unit of units) {
    if (busy.has(unit.id)) continue;
    // Conditional on the status read above, so a van that got held between
    // that read and now is left alone rather than overwritten.
    const freed = await db.unit.updateMany({
      where: { id: unit.id, status: { in: ['HELD', 'ON_JOB'] } },
      data: { status: 'AVAILABLE' },
    });
    if (freed.count > 0) vansFreed.push(unit.code);
  }
  return { offersTimedOut, holdsReleased, vansFreed };
}

// RIGHT AFTER A JOB IS COMPLETED, in DEMO_MODE only.
//
// Completing a job does not put its van back to AVAILABLE anywhere in the
// product — the only code that ever sets a unit AVAILABLE is releasing a crew
// during a reassignment. On the demo board that means crew B stays ON_JOB
// after every finished job, and the next job the presenter reports goes to D
// until the fifteen-minute refresh catches up. Running the same clean-up the
// moment a job completes closes that for the demo. (The product-wide gap is
// recorded in DECISIONS.log; fixing it for every deployment is out of scope.)
// Never throws: a completed job must not turn into an error on the phone.
export async function freeDemoVansAfterCompletion(db: PrismaClient): Promise<void> {
  if (!config.demoMode) return;
  try {
    await freeStuckDemoVans(db);
  } catch (error) {
    logger.error({ err: error }, 'demo van clean-up after completion failed');
  }
}
