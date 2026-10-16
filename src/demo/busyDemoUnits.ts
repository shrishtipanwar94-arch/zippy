// WHICH DEMO VANS ARE IN THE MIDDLE OF SOMETHING, and so must be left alone.
//
// Both the boot-time seed and the fifteen-minute refresh rewrite demo rows:
// they put a van back to AVAILABLE, move it home, re-open its shift and
// re-count its stock. Doing any of that to a van that is on a job breaks
// invariant 7 ("one active job per unit") from the fixture side — the van
// reads AVAILABLE while a job is still assigned to it, so the next dispatch
// puts a SECOND active job on it. That happened once already, while verifying
// the original one-van demo seed: two holds 46 seconds apart, both CONSUMED,
// because a re-seed landed between them.
//
// "Busy" is either of two things, because a van is committed before its job
// is: an unfinished job assigned to it, or an ACTIVE hold that has not yet
// expired (a technician's phone is counting down an offer for it right now).
//
// AN EXPIRED HOLD IS NOT BUSY, even while it still reads ACTIVE. `consumeHold`
// only consumes `WHERE status = 'ACTIVE' AND expires_at > now`, so past its
// expiry nobody can complete it; the cleanup sweep just has not flipped it to
// EXPIRED yet. Counting it would freeze a demo van for as long as the sweep
// was down — found in the shared test database, where no sweep runs at all.

import type { PrismaClient } from '@prisma/client';

// The same three statuses `FINISHED_JOB_STATUSES` names in src/api/console.ts
// and src/api/driver.ts. A job in any of these is over; anything else is live.
const FINISHED_JOB_STATUSES = ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] as const;

export async function findBusyUnitIds(
  db: PrismaClient,
  unitIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const liveJobs = await db.job.findMany({
    where: { assignedUnitId: { in: unitIds }, status: { notIn: [...FINISHED_JOB_STATUSES] } },
    select: { assignedUnitId: true },
  });
  const activeHolds = await db.unitHold.findMany({
    where: { unitId: { in: unitIds }, status: 'ACTIVE', expiresAt: { gt: now } },
    select: { unitId: true },
  });

  const busy = new Set<string>();
  for (const job of liveJobs) {
    if (job.assignedUnitId) busy.add(job.assignedUnitId);
  }
  for (const hold of activeHolds) {
    busy.add(hold.unitId);
  }
  return busy;
}
