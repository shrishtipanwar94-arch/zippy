// TAKE A DEMO JOB OFF THE BOARD WITHOUT DELETING IT.
//
// The dry check (scripts/demo-dry-check.ts) files a real job per fault type
// through the real driver path, and each one has to be gone again before the
// next — or crew B would be busy and the dispatcher's board would fill up.
// The system has no job cancellation route (a CANCEL_JOB card kind exists, but
// nothing executes it), and job rows are never deleted: job_events is
// append-only, and the rule for the live demo is to hide, not destroy.
//
// So a retired job is CANCELLED, with a JobEvent saying why (every state
// transition writes one), and its still-open cards are closed so they do not
// sit in the dispatcher's queue. Only for jobs that are not finished, and only
// for the demo tenant's jobs: this is a demo fixture, not a product feature.
//
// The van is NOT touched here. The caller declines the offer through the real
// technician route first, which unwinds the reservation and frees the van the
// normal way.

import type { PrismaClient } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { resolveAction } from '../commit/actionRequests.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { DEMO_TENANT_ID } from './demoCrews.js';

const FINISHED_JOB_STATUSES = ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] as const;

export async function retireDemoJob(db: PrismaClient, jobId: string, reason: string): Promise<boolean> {
  const retired = await runPublishingTransaction(db, async (tx) => {
    const updated = await tx.job.updateMany({
      where: { id: jobId, tenantId: DEMO_TENANT_ID, status: { notIn: [...FINISHED_JOB_STATUSES] } },
      data: { status: 'CANCELLED' },
    });
    if (updated.count === 0) return false;
    await appendJobEvent(tx, {
      jobId,
      eventType: 'JOB_CANCELLED',
      payload: { reason },
      actorRole: 'SYSTEM',
    });
    return true;
  });
  if (!retired) return false;

  const openCards = await db.actionRequest.findMany({
    where: { jobId, status: 'PENDING' },
    select: { id: true },
  });
  for (const card of openCards) {
    await resolveAction(db, {
      actionRequestId: card.id,
      decision: 'CANCELLED',
      approver: { role: 'SYSTEM', id: null },
      note: reason,
    });
  }
  return true;
}
