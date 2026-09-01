// WHAT THE TECHNICIAN USED, declared at the end of the job.
//
// This is the only path by which parts leave a van, and it is a DECLARATION —
// nobody watched them do it, so what lands in the ledger is what the person on
// scene says they fitted. That is also why it does not refresh the shelf's
// confirmed_at: using one drive belt is not the same as having counted the
// drive belts, and pretending otherwise would make every busy van look freshly
// verified without anybody ever having looked in it.
//
// THE TAP IS THE KEY. The phone mints ONE id for the declaration and each line
// derives its movement id from it (`<declarationId>:<partId>`), so a double tap
// or an offline replay is the same set of movement ids and collides on the
// primary key. The whole declaration is one transaction: three parts fitted on
// one job is one act, and half of it landing is worse than none of it.
//
// A REPLAY IS ANSWERED, NOT REDONE. P2002 anywhere in the transaction rolls the
// entire attempt back — every decrement, the event, the restock request — and
// we answer with what the ledger already holds. The one thing we cannot
// reproduce is a line that was REJECTED first time round, because a rejection
// writes nothing by design; the phone re-reads the van after any answer, which
// is where the real state comes from anyway.

import type { Prisma, PrismaClient } from '@prisma/client';
import { appendJobEvent } from '../intake/events.js';
import { isUniqueViolation } from '../infra/prismaErrors.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { applyStockMovement } from './stockMovements.js';
import type { StockMovementOutcome } from './stockMovements.js';

// The statuses at which "I used these parts" is a sentence that makes sense.
// Not COMMITTED or EN_ROUTE: nobody has opened the bonnet yet, and a
// declaration from a van that is still driving is a mis-tap.
const DECLARABLE_STATUSES = ['ON_SITE', 'DIAGNOSING', 'WORKING', 'AWAITING_APPROVAL', 'RESOLVED'];

export type ConsumptionLine = { partId: string; quantity: number };

export type ConsumptionInput = {
  jobId: string;
  technicianId: string;
  // One id per tap, minted by the phone. Every line's movement id derives from
  // it, so the whole declaration replays as one.
  declarationId: string;
  lines: ConsumptionLine[];
  eventTime: Date;
};

export type ConsumptionOutcome =
  | { outcome: 'RECORDED'; lines: StockMovementOutcome[] }
  | { outcome: 'REPLAYED'; detail: string }
  | { outcome: 'REJECTED'; detail: string };

export async function declareConsumption(
  db: PrismaClient,
  input: ConsumptionInput,
): Promise<ConsumptionOutcome> {
  try {
    return await runPublishingTransaction(db, (tx) => declareInsideTransaction(tx, input));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { outcome: 'REPLAYED', detail: 'these parts were already recorded against this job' };
  }
}

async function declareInsideTransaction(
  tx: Prisma.TransactionClient,
  input: ConsumptionInput,
): Promise<ConsumptionOutcome> {
  const job = await tx.job.findUnique({
    where: { id: input.jobId },
    select: { id: true, status: true, assignedTechnicianId: true, assignedUnitId: true },
  });
  if (!job) return { outcome: 'REJECTED', detail: 'this job no longer exists' };
  if (job.assignedTechnicianId !== input.technicianId) {
    return { outcome: 'REJECTED', detail: 'this job is no longer assigned to you' };
  }
  if (!job.assignedUnitId) {
    return { outcome: 'REJECTED', detail: 'this job has no van on it' };
  }
  if (!DECLARABLE_STATUSES.includes(job.status)) {
    return { outcome: 'REJECTED', detail: 'declare parts once you are on scene' };
  }

  // THE PARTS COME OFF THE JOB'S VAN, not off whatever the technician is
  // crewed to today. They were fitted by that unit, on that job, and a
  // re-crewing tomorrow must not move the decrement to another vehicle.
  const unitId = job.assignedUnitId;
  const lines: StockMovementOutcome[] = [];
  for (const line of input.lines) {
    lines.push(
      await applyStockMovement(tx, {
        movementId: `${input.declarationId}:${line.partId}`,
        unitId,
        partId: line.partId,
        delta: -Math.abs(line.quantity),
        reason: 'CONSUMED',
        jobId: input.jobId,
        technicianId: input.technicianId,
        eventTime: input.eventTime,
      }),
    );
  }

  const applied = lines.filter((line) => line.outcome === 'APPLIED');
  if (applied.length > 0) {
    await appendJobEvent(tx, {
      jobId: input.jobId,
      eventType: 'PARTS_CONSUMED',
      payload: {
        declarationId: input.declarationId,
        unitId,
        parts: applied.map((line) => ({
          partId: line.partId,
          used: usedQuantity(input.lines, line.partId),
          remaining: line.outcome === 'APPLIED' ? line.quantity : 0,
        })),
      },
      actorRole: 'TECHNICIAN',
      actorId: input.technicianId,
      at: input.eventTime,
    });
  }

  return { outcome: 'RECORDED', lines };
}

function usedQuantity(lines: ConsumptionLine[], partId: string): number {
  const line = lines.find((candidate) => candidate.partId === partId);
  return line ? Math.abs(line.quantity) : 0;
}
