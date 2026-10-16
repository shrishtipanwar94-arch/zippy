// KEEP THE DEMO VANS' STOCK COUNTED AND FULL.
//
// Stock confidence is a function of AGE: a count older than
// STOCK_AGEING_MAX_AGE_MINUTES (eight hours by default) reads UNVERIFIED, and
// src/engine/partSourcing.ts treats UNVERIFIED as absent — failing closed. So
// without this, B's battery would quietly "disappear" eight hours after the
// last boot, B would be rejected PART_UNAVAILABLE, and the demo would pick D.
//
// THIS IS A FIXTURE PRETENDING A RECOUNT HAPPENED, which is fine for a demo
// board and is exactly why it only ever runs under DEMO_MODE. It also tops the
// van back up, so a battery fitted during one presentation is back for the
// next. It writes the count directly rather than through a stock movement,
// the same way the seed does: this is the board being reset, not a part being
// used.

import type { PrismaClient } from '@prisma/client';
import { DEMO_STOCK_QUANTITY } from './demoCrews.js';
import { findIdleDemoCrews } from './idleDemoCrews.js';

// Returns the unit ids whose stock was re-counted.
export async function refreshDemoStock(db: PrismaClient, now: Date = new Date()): Promise<string[]> {
  const idle = await findIdleDemoCrews(db);
  const counted = { quantity: DEMO_STOCK_QUANTITY, startingQty: DEMO_STOCK_QUANTITY, confirmedAt: now };

  const refreshed: string[] = [];
  for (const { crew, unitId } of idle) {
    for (const sku of crew.stockedSkus) {
      const part = await db.part.findFirst({ where: { sku }, select: { id: true } });
      if (!part) throw new Error(`part ${sku} is not in the catalogue`);
      await db.unitStock.upsert({
        where: { unitId_partId: { unitId, partId: part.id } },
        update: counted,
        create: { unitId, partId: part.id, ...counted },
      });
    }
    refreshed.push(unitId);
  }
  return refreshed;
}
