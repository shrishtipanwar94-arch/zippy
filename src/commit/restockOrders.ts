// AN EMPTY SHELF ASKS TO BE FILLED.
//
// When a movement takes a van's count of some part to zero, a RestockOrder is
// raised in REQUESTED. Nothing in this phase acts on it: there is no supplier
// integration, no purchasing, no lead time. It is a row an operator can see,
// which is the point — invariant 8 says every degraded state is visible, and a
// van that has run out of the part it is carried to fit is a degraded van.
//
// ONE OPEN ORDER PER (UNIT, PART). The guard is a read inside the caller's
// transaction rather than a unique index, because "open" is a status and
// Postgres partial unique indexes are not expressible in the Prisma schema —
// a constraint that only exists in a hand-written migration is a constraint
// that goes missing the next time somebody regenerates. The read is enough
// here: both writers are the same technician's phone, serialised behind one
// van, and a duplicate REQUESTED row costs an operator a second line rather
// than any money.

import type { Prisma } from '@prisma/client';

const OPEN_STATUSES = ['REQUESTED', 'ORDERED'];

export async function raiseRestockIfEmpty(
  tx: Prisma.TransactionClient,
  where: { unitId: string; partId: string },
): Promise<void> {
  const open = await tx.restockOrder.findFirst({
    where: { unitId: where.unitId, partId: where.partId, status: { in: OPEN_STATUSES } },
    select: { id: true },
  });
  if (open) return;

  await tx.restockOrder.create({
    data: {
      unitId: where.unitId,
      partId: where.partId,
      // One. This system knows the van is empty; it does not know what the
      // right stocking level is, and inventing a number here would be the
      // first half of a procurement system nobody asked for.
      quantity: 1,
      status: 'REQUESTED',
    },
  });
}
