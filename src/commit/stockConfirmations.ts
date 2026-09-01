// "CONFIRM STOCK" — a technician standing at the open back doors of the van,
// counting, and telling us what is actually there.
//
// It is the only thing in the system that can make a quantity trustworthy
// again. Everything else — consumption, replenishment, the seed — moves a
// number the system worked out for itself; this moves a number a person
// looked at. So it does two separate things per part, and they are separate on
// purpose:
//
//   1. STAMPS confirmed_at. This happens for every line, including the ones
//      where the count matched, because the valuable thing is the LOOKING, not
//      the disagreement. src/domain/stockConfidence.ts turns the age of that
//      stamp into VERIFIED / AGEING / UNVERIFIED.
//
//   2. RECONCILES, when the count differs. The correction is an ADJUSTED
//      movement for the difference, never an overwrite of `quantity` — the
//      ledger has to keep explaining the number, and "somebody found two fewer
//      than we thought on Tuesday" is exactly the row an audit wants.
//
// Idempotent the same way a consumption is: one id per tap, each line deriving
// both its confirmation id and its adjustment id from it, so a replay collides
// on a primary key and the whole transaction rolls back.

import type { Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../infra/prismaErrors.js';
import { applyStockMovement } from './stockMovements.js';

export type CountedLine = { partId: string; quantity: number };

export type ConfirmationInput = {
  unitId: string;
  technicianId: string;
  // One id per tap, minted by the phone.
  confirmationId: string;
  counted: CountedLine[];
  confirmedAt: Date;
};

export type ConfirmationLineOutcome = {
  partId: string;
  // What the system believed before the technician counted.
  expected: number;
  counted: number;
  // The ADJUSTED movement written to close the gap, if there was one.
  adjustedBy: number;
};

export type ConfirmationOutcome =
  | { outcome: 'CONFIRMED'; lines: ConfirmationLineOutcome[] }
  | { outcome: 'REPLAYED'; detail: string }
  | { outcome: 'REJECTED'; detail: string };

export async function confirmVanStock(
  db: PrismaClient,
  input: ConfirmationInput,
): Promise<ConfirmationOutcome> {
  if (input.counted.length === 0) {
    return { outcome: 'REJECTED', detail: 'nothing was counted' };
  }
  try {
    // No `runPublishingTransaction` here: counting a van is not a job event.
    // It belongs to a unit, not to any incident, and there is no job room to
    // fan it out to.
    return await db.$transaction((tx) => confirmInsideTransaction(tx, input));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return { outcome: 'REPLAYED', detail: 'this count has already been recorded' };
  }
}

async function confirmInsideTransaction(
  tx: Prisma.TransactionClient,
  input: ConfirmationInput,
): Promise<ConfirmationOutcome> {
  const lines: ConfirmationLineOutcome[] = [];

  for (const line of input.counted) {
    const counted = Math.max(0, Math.trunc(line.quantity));
    const shelf = await tx.unitStock.findUnique({
      where: { unitId_partId: { unitId: input.unitId, partId: line.partId } },
      select: { id: true, quantity: true },
    });
    const expected = shelf?.quantity ?? 0;
    const difference = counted - expected;

    if (difference !== 0) {
      await applyStockMovement(tx, {
        movementId: `${input.confirmationId}:${line.partId}`,
        unitId: input.unitId,
        partId: line.partId,
        delta: difference,
        reason: 'ADJUSTED',
        technicianId: input.technicianId,
        eventTime: input.confirmedAt,
      });
    }

    // AFTER the adjustment, and unconditionally. A count that agreed with us
    // still resets the clock; that is the whole product of this action.
    await tx.unitStock.updateMany({
      where: { unitId: input.unitId, partId: line.partId },
      data: { confirmedAt: input.confirmedAt, version: { increment: 1 } },
    });

    await tx.stockConfirmation.create({
      data: {
        id: `${input.confirmationId}:${line.partId}`,
        unitId: input.unitId,
        technicianId: input.technicianId,
        partId: line.partId,
        quantity: counted,
        confirmedAt: input.confirmedAt,
      },
    });

    lines.push({ partId: line.partId, expected, counted, adjustedBy: difference });
  }

  return { outcome: 'CONFIRMED', lines };
}
