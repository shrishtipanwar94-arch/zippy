// WHEN EACH VAN WAS LAST COUNTED — the seed's version of a shift's history.
//
// Without this every seeded shelf reads UNVERIFIED, because nobody has ever
// looked in the back of any of these vans. That is truthful and useless: the
// whole subject of Phase 18 is the difference between a fresh count, a stale
// one and no count at all, and a board where every row says the same word
// demonstrates none of it.
//
// So the fleet is staggered across the three bands, deterministically by unit
// number: a third counted within the last hour, a third counted this morning,
// and a third never counted at all. The thresholds live in config
// (STOCK_VERIFIED_MAX_AGE_MINUTES / STOCK_AGEING_MAX_AGE_MINUTES) and this
// picks ages either side of the defaults rather than importing them — a seed
// that read the app's config would silently re-band itself when somebody tuned
// a threshold, which is exactly the case a demo needs to be able to show.
//
// THE CONFIRMATION ROW IS THE EVIDENCE, so the seed writes one rather than
// only stamping `unit_stock.confirmed_at`. A confidence level with nothing
// behind it is a number we made up, and stock_confirmations is append-only for
// that reason.
//
// Ids carry the DATE. Running the seed twice in one day changes nothing, which
// is the seed's contract; running it tomorrow records a fresh count, which is
// what "set the demo up for today" has to mean when the thing being
// demonstrated is age.

import type { PrismaClient } from '@prisma/client';

// Minutes ago, by unit number modulo three. 40 is inside the two-hour VERIFIED
// band; 300 is five hours, inside the eight-hour AGEING band; null is a van
// nobody has opened.
function countedMinutesAgo(unitNumber: number): number | null {
  const band = unitNumber % 3;
  if (band === 0) return 40;
  if (band === 1) return 300;
  return null;
}

export async function seedVanCounts(prisma: PrismaClient): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const shelves = await prisma.unitStock.findMany({
    select: { unitId: true, partId: true, quantity: true, unit: { select: { code: true } } },
  });

  for (const shelf of shelves) {
    const unitNumber = Number(shelf.unit.code.replace(/\D/g, ''));
    const minutes = countedMinutesAgo(unitNumber);
    if (minutes === null) continue;

    const confirmedAt = new Date(Date.now() - minutes * 60_000);
    await prisma.stockConfirmation.upsert({
      where: { id: `stockconf-${today}-${shelf.unitId}-${shelf.partId}` },
      update: {},
      create: {
        id: `stockconf-${today}-${shelf.unitId}-${shelf.partId}`,
        unitId: shelf.unitId,
        // No technician: this is the seed standing in for a count, not a claim
        // that a named person made one.
        technicianId: 'seed',
        partId: shelf.partId,
        // The count AGREED with the ledger, so there is no adjustment to make
        // and `quantity` is left exactly as the movements explain it.
        quantity: shelf.quantity,
        confirmedAt,
      },
    });
    await prisma.unitStock.updateMany({
      where: { unitId: shelf.unitId, partId: shelf.partId },
      data: { confirmedAt },
    });
  }
}
