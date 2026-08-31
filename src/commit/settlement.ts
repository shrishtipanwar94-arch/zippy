// RESOLVING THE SETTLEMENT PATH — the database half of the rule.
//
// `src/domain/settlementPath.ts` decides; this fetches the three facts it
// decides from. The split is the same one the price list follows: WHICH terms
// apply is a question about contracts and time, answered once at job creation
// and pinned to the row, and the answering is worth being able to test without
// a database.
//
// SERVICE TYPE IS THE JOIN KEY, and it is derived rather than stored on the
// job: `covered_services` is keyed by (contract, serviceType), and the seeded
// contracts carry STANDARD and HIGHWAY — the same two the callout fee uses.
// Deriving both from `on_highway` means a job cannot be priced as a highway
// callout and covered as a standard one.

import type { Prisma } from '@prisma/client';
import type { SettlementPath } from '@prisma/client';
import { resolveSettlementPath } from '../domain/settlementPath.js';

// The service type a contract's coverage is looked up by. One derivation, used
// by both the callout fee and the coverage check.
export function serviceTypeFor(onHighway: boolean | null): string {
  return onHighway ? 'HIGHWAY' : 'STANDARD';
}

export type SettlementQuery = {
  tenantId: string | null;
  onHighway: boolean | null;
  at: Date;
};

export async function settlementPathFor(
  tx: Prisma.TransactionClient,
  query: SettlementQuery,
): Promise<SettlementPath> {
  // No tenant at all cannot happen through intake — every driver belongs to
  // one, walk-in consumers included — but the column is nullable, so the
  // honest answer for a job without one is the path that assumes nothing.
  if (!query.tenantId) {
    return resolveSettlementPath({ tenantKind: null, hasActiveContract: false, serviceCovered: false });
  }

  const tenant = await tx.tenant.findUnique({
    where: { id: query.tenantId },
    select: {
      kind: true,
      contracts: {
        where: {
          active: true,
          startsAt: { lte: query.at },
          OR: [{ endsAt: null }, { endsAt: { gt: query.at } }],
        },
        // The most recently started, if a tenant somehow has two open at once.
        orderBy: { startsAt: 'desc' },
        take: 1,
        select: {
          id: true,
          coveredServices: {
            where: { serviceType: serviceTypeFor(query.onHighway), covered: true },
            select: { id: true },
          },
        },
      },
    },
  });

  const contract = tenant?.contracts[0];

  return resolveSettlementPath({
    tenantKind: tenant?.kind ?? null,
    hasActiveContract: Boolean(contract),
    serviceCovered: (contract?.coveredServices.length ?? 0) > 0,
  });
}
