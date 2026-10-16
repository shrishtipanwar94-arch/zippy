// CLEAR A DEMO JOB NOBODY FINISHED, so the next demo starts on two jobs.
//
// The dispatcher's board in demo mode shows the demo tenant's live jobs plus
// the reference job (src/demo/demoScope.ts). Act 6 ends with a declined job
// still PLANNED — nobody can sign in as crew D to take it — and a presenter can
// walk away from any act half way. Without this, the next audience would open
// the board on three or four jobs. The product has no route to cancel a job,
// so the worker's fifteen-minute demo refresh does it instead.
//
// RETIRED, NOT DELETED: CANCELLED with a JobEvent, through retireDemoJob. Only
// a job that has sat unassigned for over an hour, with no live hold — never a
// job a crew is on, and never the reference job.

import type { PrismaClient } from '@prisma/client';
import { retireDemoJob } from './retireDemoJob.js';
import { DEMO_REFERENCE_DRIVER, DEMO_TENANT_ID } from './demoCrews.js';

export const STALE_DEMO_JOB_AFTER_MS = 60 * 60_000;

export async function retireStaleDemoJobs(db: PrismaClient, now: Date = new Date()): Promise<string[]> {
  const stale = await db.job.findMany({
    where: {
      tenantId: DEMO_TENANT_ID,
      status: { in: ['INTAKE', 'PLANNED'] },
      assignedUnitId: null,
      createdAt: { lt: new Date(now.getTime() - STALE_DEMO_JOB_AFTER_MS) },
      vehicle: { registration: { not: DEMO_REFERENCE_DRIVER.registration } },
      unitHolds: { none: { status: 'ACTIVE', expiresAt: { gt: now } } },
    },
    select: { id: true },
  });

  const retired: string[] = [];
  for (const job of stale) {
    const done = await retireDemoJob(db, job.id, 'demo refresh: left unfinished for over an hour');
    if (done) retired.push(job.id);
  }
  return retired;
}
