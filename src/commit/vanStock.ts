// THE VAN STOCK SCREEN, read out of Postgres in one place.
//
// A read rather than a write, in /src/commit for the same reason
// dispatchSnapshot.ts is: it is the ONE query that turns stock rows into the
// shape everything else talks about, and having two of those is how a
// dispatcher's screen and a technician's screen start disagreeing about the
// same van.
//
// The confidence level is computed HERE and not stored. It changes with the
// clock and nothing else — a row that was VERIFIED at nine is AGEING at
// eleven with no write in between — so a stored column would need a sweep to
// keep it honest, and a sweep that falls behind is worse than no column.

import type { PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { minutesSince, stockConfidence } from '../domain/stockConfidence.js';
import type { StockAgeThresholds, StockConfidence } from '../domain/stockConfidence.js';

export const STOCK_AGE_THRESHOLDS: StockAgeThresholds = {
  verifiedUnderMinutes: config.STOCK_VERIFIED_MAX_AGE_MINUTES,
  ageingUnderMinutes: config.STOCK_AGEING_MAX_AGE_MINUTES,
};

export type VanStockLine = {
  partId: string;
  sku: string;
  name: string;
  quantity: number;
  confirmedAt: string | null;
  minutesSinceConfirmed: number | null;
  confidence: StockConfidence;
};

export type VanStock = {
  unitId: string;
  unitCode: string;
  asOf: string;
  lines: VanStockLine[];
  // What an operator actually wants to know at a glance: how much of this van
  // is believable. Invariant 8 — a van whose stock nobody has counted since
  // yesterday is a degraded state, and it should be legible without arithmetic.
  summary: { verified: number; ageing: number; unverified: number };
};

export async function readVanStock(
  db: PrismaClient,
  unitId: string,
  now: Date,
): Promise<VanStock | null> {
  const unit = await db.unit.findUnique({ where: { id: unitId }, select: { id: true, code: true } });
  if (!unit) return null;

  const rows = await db.unitStock.findMany({
    where: { unitId },
    orderBy: { part: { name: 'asc' } },
    select: {
      partId: true,
      quantity: true,
      confirmedAt: true,
      part: { select: { sku: true, name: true } },
    },
  });

  const lines = rows.map((row) => ({
    partId: row.partId,
    sku: row.part.sku,
    name: row.part.name,
    quantity: row.quantity,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    minutesSinceConfirmed: row.confirmedAt ? minutesSince(row.confirmedAt, now) : null,
    confidence: stockConfidence(row.confirmedAt, now, STOCK_AGE_THRESHOLDS),
  }));

  return {
    unitId: unit.id,
    unitCode: unit.code,
    asOf: now.toISOString(),
    lines,
    summary: {
      verified: lines.filter((line) => line.confidence === 'VERIFIED').length,
      ageing: lines.filter((line) => line.confidence === 'AGEING').length,
      unverified: lines.filter((line) => line.confidence === 'UNVERIFIED').length,
    },
  };
}
