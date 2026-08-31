// THE RATES ON ONE LIST, AS AT ONE INSTANT.
//
// A price list is versioned, and so is every row inside it: a part price, a
// labour rate, a tow tariff and a callout fee each carry their own
// validFrom/validTo. So "what does a drive belt cost?" is not a question about
// a list, it is a question about a list AND a moment.
//
// THE MOMENT IS ALWAYS THE JOB'S CREATION TIME, never now. That is the same
// rule `priceList.ts` pins the list with, applied one level down — pinning the
// list but then reading today's rates inside it would re-price the job through
// the back door, which is exactly the failure the pinning exists to prevent.
// Every function here therefore takes `at`, and every caller passes the job's
// `createdAt`.
//
// A MISSING RATE RETURNS NULL. It is not an exception, because the honest
// answer is "this list does not price that", and the caller — an estimate
// builder — has to decide what to do about a line it cannot price. Throwing
// from a lookup would make a missing tow tariff look like a system failure
// rather than a gap in a catalogue somebody has to fill in.

import type { Prisma } from '@prisma/client';
import type { CalloutRate, LabourRate, PartRate, TowRate } from '../domain/pricing.js';

// The version window every row in a price list carries. Written once here
// rather than four times below, because four copies of a date comparison is
// four chances to get one of them backwards.
function inForceAt(at: Date) {
  return {
    validFrom: { lte: at },
    OR: [{ validTo: null }, { validTo: { gt: at } }],
  };
}

export async function partRate(
  tx: Prisma.TransactionClient,
  query: { priceListId: string; partId: string; at: Date },
): Promise<PartRate | null> {
  const row = await tx.partPrice.findFirst({
    where: { priceListId: query.priceListId, partId: query.partId, ...inForceAt(query.at) },
    orderBy: { validFrom: 'desc' },
    select: { unitPricePaise: true, part: { select: { id: true, name: true } } },
  });
  if (!row) return null;

  return {
    partId: row.part.id,
    description: row.part.name,
    unitPricePaise: row.unitPricePaise,
  };
}

export async function labourRate(
  tx: Prisma.TransactionClient,
  query: { priceListId: string; code: string; at: Date },
): Promise<LabourRate | null> {
  const row = await tx.labourRate.findFirst({
    where: { priceListId: query.priceListId, code: query.code, ...inForceAt(query.at) },
    orderBy: { validFrom: 'desc' },
    select: { code: true, ratePerHourPaise: true },
  });
  return row ? { code: row.code, ratePerHourPaise: row.ratePerHourPaise } : null;
}

export async function towRate(
  tx: Prisma.TransactionClient,
  query: { priceListId: string; towType: string; at: Date },
): Promise<TowRate | null> {
  const row = await tx.towTariff.findFirst({
    where: { priceListId: query.priceListId, towType: query.towType, ...inForceAt(query.at) },
    orderBy: { validFrom: 'desc' },
    select: { towType: true, perKmPaise: true, minChargePaise: true },
  });
  return row
    ? { towType: row.towType, perKmPaise: row.perKmPaise, minChargePaise: row.minChargePaise }
    : null;
}

export async function calloutRate(
  tx: Prisma.TransactionClient,
  query: { priceListId: string; serviceType: string; at: Date },
): Promise<CalloutRate | null> {
  const row = await tx.calloutFee.findFirst({
    where: { priceListId: query.priceListId, serviceType: query.serviceType, ...inForceAt(query.at) },
    orderBy: { validFrom: 'desc' },
    select: { serviceType: true, feePaise: true },
  });
  return row ? { serviceType: row.serviceType, feePaise: row.feePaise } : null;
}
