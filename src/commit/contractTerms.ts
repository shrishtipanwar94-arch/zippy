// WHICH SLA POLICY A JOB IS SERVED UNDER — decided once, at creation.
//
// The third thing pinned to a job row at intake, alongside `price_list_id`
// (what it costs) and `settlement_path` (who pays), and pinned for exactly the
// same reason: THE TERMS A CUSTOMER IS SERVED UNDER ARE THE TERMS IN FORCE
// WHEN THEY ASKED FOR HELP. A contract that lapses, is re-tiered or has its
// response window edited while a technician is driving out does not
// retroactively change the promise the customer was made — and it must not
// silently change what the solver is optimising for halfway through a job
// either, because a job whose objective moves mid-flight produces a re-plan
// nobody can explain.
//
// So this runs once, inside the intake transaction, and writes an id. Every
// later reader — the cost function's contract exposure term, the priority
// queue, the SLA escalation sweep — follows `jobs.sla_policy_id` rather than
// asking the clock what the contract says now.
//
// SERVICE TYPE IS THE JOIN KEY and it is derived, not stored: the same
// `serviceTypeFor(onHighway)` the callout fee and the coverage check already
// use (src/commit/settlement.ts). One derivation means a job cannot be priced
// as a highway callout and served under a standard response window.

import type { Prisma } from '@prisma/client';
import { serviceTypeFor } from './settlement.js';

export type ContractTermsQuery = {
  tenantId: string | null;
  onHighway: boolean | null;
  at: Date;
};

// Null when nothing applies, and the null is ordinary rather than exceptional:
// a walk-in consumer has no contract, so there is no window to promise and no
// penalty to expose. `slaResponseMinutes` on the snapshot is null for these
// jobs, and both feasibility and cost already treat that as "no SLA at all"
// rather than as a very generous one.
export async function slaPolicyIdInForce(
  tx: Prisma.TransactionClient,
  query: ContractTermsQuery,
): Promise<string | null> {
  if (!query.tenantId) return null;

  const contract = await tx.contract.findFirst({
    where: {
      tenantId: query.tenantId,
      active: true,
      startsAt: { lte: query.at },
      OR: [{ endsAt: null }, { endsAt: { gt: query.at } }],
    },
    // The most recently started, if a tenant somehow has two open at once —
    // the same tie-break settlementPathFor uses, so the two cannot disagree
    // about which contract a job was created under.
    orderBy: { startsAt: 'desc' },
    select: {
      slaPolicies: {
        where: { serviceType: serviceTypeFor(query.onHighway) },
        select: { id: true },
      },
    },
  });

  return contract?.slaPolicies[0]?.id ?? null;
}
