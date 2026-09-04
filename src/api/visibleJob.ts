// "MAY THIS CALLER SEE THIS JOB AT ALL?" — asked once, in one place.
//
// Every route that acts on a job resolves it through the SCOPED client first
// and then does the real work through `prismaBase`. That two-step is the
// pattern the whole API follows: the scoped read is the authorisation, and the
// unscoped write is the work.
//
// This function existed five times — chat.ts, checkout.ts, escalation.ts,
// estimates.ts, intake.ts — as five identical copies, with two more spelled out
// inline in diagnosis.ts and driver.ts. That is how the cross-tenant technician
// bug stayed invisible for so long: the rule was not wrong in one file, it was
// the same rule written seven times, and nobody reading any single copy could
// see that it disagreed with the ladder endpoints next door.
//
// It is one function now, so the next correction lands everywhere at once.
// Where the scoping rules themselves live:
//   src/infra/tenantScopeExtension.ts   the caller's tenant
//   src/infra/jobOwnershipExtension.ts  a driver's own jobs, a technician's
//                                       assigned ones
// Neither is applied here. This just asks, and the extensions answer.

import { prisma } from '../infra/db.js';

export async function visibleJobId(id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || id.length === 0) return null;
  const job = await prisma.job.findFirst({ where: { id }, select: { id: true } });
  return job?.id ?? null;
}
