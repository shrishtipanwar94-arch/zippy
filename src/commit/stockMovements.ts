// THE ONE PLACE A VAN'S STOCK LEVEL CHANGES.
//
// Every part that leaves or joins a van goes through this function, and it
// does exactly two things in one transaction: append a row to the ledger, and
// move the cached quantity by the same amount. That pairing is what keeps
//     starting_qty + SUM(delta) = quantity
// true for every row, which is the property this phase is checked on.
//
// IDEMPOTENT ON THE MOVEMENT ID. `stock_movements.id` has no default: the
// phone mints it at the moment of the tap and every retry carries the same
// one. The insert is LAST in the transaction, so a duplicate raises P2002 and
// takes the decrement down with it — a double tap, or an offline replay,
// decrements once. This is the same shape as commit/technicianActions.ts, and
// deliberately so: one mechanism for "have I seen this tap before", written
// twice rather than abstracted into a helper neither file would read well
// through.
//
// OPTIMISTIC LOCKING
// Two writers can touch one shelf at the same moment — a technician declaring
// what they used while a depot run replenishes the same van. Rather than
// locking the row, we UPDATE conditionally on the version we read. If somebody
// else got there first the version changed, zero rows are affected, and we
// know we lost; we re-read and try again. Three attempts, because the loser of
// a race that keeps losing is a bug and should surface as one rather than spin.
//
// PARTS DO NOT MOVE BETWEEN VANS, and there is no TRANSFER reason here. Two
// technicians meeting to hand over a starter motor is a real thing that
// happens, and modelling it is a cliff: it needs a second unit's version, a
// custody state while the part is in neither van, a rendezvous the solver would
// have to price, and a story for what happens when one of them is re-dispatched
// mid-handover. Phase 19 prices a workshop run instead, which is one leg with
// one owner.

import type { Prisma } from '@prisma/client';
import { raiseRestockIfEmpty } from './restockOrders.js';

export type StockMovementReason = 'CONSUMED' | 'REPLENISHED' | 'ADJUSTED';

export type StockMovementInput = {
  // Minted by the caller's client, never by the server. See the header.
  movementId: string;
  unitId: string;
  partId: string;
  // Signed: negative takes parts off the van, positive puts them on.
  delta: number;
  reason: StockMovementReason;
  jobId?: string | null;
  technicianId?: string | null;
  // When it happened, which for an offline declaration is well before we heard
  // about it. `received_at` defaults to now and records the other half.
  eventTime: Date;
};

export type StockMovementOutcome =
  | { outcome: 'APPLIED'; partId: string; quantity: number }
  | { outcome: 'REJECTED'; partId: string; detail: string };

const MAX_ATTEMPTS = 3;

// Runs INSIDE a transaction the caller owns, because a declaration of three
// parts is one act and must land or not land as one. The caller is also the
// one that catches P2002 and answers REPLAYED — see partsConsumption.ts.
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  input: StockMovementInput,
): Promise<StockMovementOutcome> {
  if (input.delta === 0) {
    return { outcome: 'REJECTED', partId: input.partId, detail: 'a movement of zero parts' };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shelf = await findOrCreateShelf(tx, input);
    if (!shelf) {
      return {
        outcome: 'REJECTED',
        partId: input.partId,
        detail: 'this van does not carry that part',
      };
    }
    if (shelf.quantity + input.delta < 0) {
      // FAIL CLOSED. A van cannot hold minus one battery, and a declaration
      // that would take it there means the count was already wrong — which is
      // worth telling the technician about rather than silently flooring at
      // zero and hiding the discrepancy.
      return {
        outcome: 'REJECTED',
        partId: input.partId,
        detail: `only ${shelf.quantity} on the van`,
      };
    }

    const moved = await tx.unitStock.updateMany({
      where: { id: shelf.id, version: shelf.version },
      data: { quantity: { increment: input.delta }, version: { increment: 1 } },
    });
    if (moved.count === 0) continue; // Somebody else moved this shelf. Re-read.

    const quantity = shelf.quantity + input.delta;
    await tx.stockMovement.create({
      data: {
        id: input.movementId,
        unitId: input.unitId,
        unitStockId: shelf.id,
        partId: input.partId,
        delta: input.delta,
        reason: input.reason,
        jobId: input.jobId ?? null,
        technicianId: input.technicianId ?? null,
        eventTime: input.eventTime,
      },
    });

    if (quantity === 0 && input.delta < 0) {
      await raiseRestockIfEmpty(tx, { unitId: input.unitId, partId: input.partId });
    }

    return { outcome: 'APPLIED', partId: input.partId, quantity };
  }

  return {
    outcome: 'REJECTED',
    partId: input.partId,
    detail: 'the stock level kept changing under us — try again',
  };
}

// A shelf that does not exist yet is only creatable by putting parts ON it. A
// van that never carried alternators cannot consume one, and saying so is more
// useful than inventing a row at minus one.
async function findOrCreateShelf(
  tx: Prisma.TransactionClient,
  input: StockMovementInput,
): Promise<{ id: string; quantity: number; version: number } | null> {
  const existing = await tx.unitStock.findUnique({
    where: { unitId_partId: { unitId: input.unitId, partId: input.partId } },
    select: { id: true, quantity: true, version: true },
  });
  if (existing) return existing;
  if (input.delta < 0) return null;

  // startingQty 0, because this shelf genuinely started empty — the movement
  // about to be written is the whole explanation of what is on it.
  return tx.unitStock.create({
    data: { unitId: input.unitId, partId: input.partId, quantity: 0, startingQty: 0 },
    select: { id: true, quantity: true, version: true },
  });
}
