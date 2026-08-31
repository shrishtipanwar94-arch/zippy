// WHICH PRICES APPLY — decided once, at job creation, and never again.
//
// THE RULE THIS FILE EXISTS FOR:
//
//   A job prices against the list IN FORCE AT JOB CREATION and is never
//   re-priced.
//
// The reason is not technical. The customer agreed to one set of numbers, at
// one moment, and a job that quietly re-prices when a new list goes live is a
// job whose final invoice does not match what anybody was told. It is the same
// rule contract terms follow at Phase 20, for the same reason.
//
// STORING `price_list_id` ON THE JOB IS THE MECHANISM. Resolving "the current
// list" again at estimate time, or at capture time, would be a different
// answer on a different day — so the answer is computed once and pinned. Every
// later question ("what does this part cost on this job?") reads the pinned id
// rather than the clock. That is what makes "a price list expiring mid-job"
// a non-event, and it is the property the test asserts.
//
// A LIST IS IN FORCE when it is active, has started, and has not ended.
// `validTo` null means open-ended, which is the normal state of the current
// list — a list is usually ended by the arrival of its successor rather than
// by having known its own end date in advance.
//
// TENANT LISTS BEAT THE GLOBAL ONE. `price_lists.tenant_id` is nullable: null
// is the public list everyone gets, and a row with a tenant is that fleet's
// negotiated rates. When both are in force the tenant's wins, which is the
// only thing a per-tenant price list could sensibly mean.

import type { Prisma } from '@prisma/client';

export type InForceQuery = {
  // Null for a walk-in consumer, who can only ever match the public list.
  tenantId: string | null;
  at: Date;
};

export async function priceListInForce(
  tx: Prisma.TransactionClient,
  query: InForceQuery,
): Promise<string | null> {
  const candidates = await tx.priceList.findMany({
    where: {
      active: true,
      validFrom: { lte: query.at },
      // TWO separate OR groups, so they go inside AND rather than both trying
      // to be the one `OR` key an object can hold — "open-ended or not ended
      // yet" AND "ours or public" are different questions.
      AND: [
        { OR: [{ validTo: null }, { validTo: { gt: query.at } }] },
        // The tenant's own list, or the public one. Never another tenant's.
        query.tenantId
          ? { OR: [{ tenantId: query.tenantId }, { tenantId: null }] }
          : { tenantId: null },
      ],
    },
    orderBy: [
      // A TENANT'S OWN LIST FIRST, and `nulls: 'last'` is doing the work.
      // Postgres treats NULL as the LARGEST value, so a plain `DESC` puts the
      // public row (tenant_id NULL) FIRST — the exact opposite of the
      // precedence wanted, and it silently gave a fleet the public prices
      // until a test caught it. Stated explicitly rather than relying on a
      // default nobody remembers correctly.
      { tenantId: { sort: 'desc', nulls: 'last' } },
      // Then the most recently started, so a mid-year replacement wins over
      // the list it replaced if both were somehow left open-ended.
      { validFrom: 'desc' },
    ],
    take: 1,
    select: { id: true },
  });

  return candidates[0]?.id ?? null;
}
