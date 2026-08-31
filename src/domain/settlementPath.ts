// WHICH OF THE THREE WAYS THIS JOB SETTLES.
//
// Zippy is a marketplace with three genuinely different commercial
// relationships, and almost every later decision about money branches on which
// one a job is:
//
//   FLEET_TENANT       a fleet with a contract. The work is invoiced monthly
//                      against that contract. NO GATEWAY IS EVER CALLED — there
//                      is no card, and a fleet manager would be startled to
//                      find one being charged.
//   CONTRACT_CONSUMER  an individual whose contract covers this service. Zero
//                      payable and no gateway — but they still see the
//                      estimate, with the deduction, because "your cover paid
//                      for this" is the thing they bought.
//   WALK_IN            nobody's contract covers it. Authorise, then capture.
//
// PURE, AND DELIBERATELY NOT A DATABASE QUERY. What it takes is three facts —
// is the tenant a fleet, is there an active contract, does that contract cover
// this service — and the fetching of those facts is somebody else's job
// (src/commit/settlement.ts). That split is what lets the rule be argued with
// in a test rather than inferred from a join.
//
// RESOLVED ONCE, AT JOB CREATION, and pinned to `jobs.settlement_path` — the
// same rule the price list follows and for the same reason. A contract that
// lapses while a technician is driving out does not retroactively hand the
// customer a bill they were never quoted.

import type { SettlementPath } from '@prisma/client';

export type SettlementQuery = {
  // FLEET or CONSUMER. A walk-in consumer tenant is still a tenant — every job
  // has one, so tenancy alone cannot tell the paths apart.
  tenantKind: 'FLEET' | 'CONSUMER' | null;
  // Whether an active contract exists for that tenant at the moment of asking.
  hasActiveContract: boolean;
  // Whether that contract's covered services include this job's service type.
  // Meaningless without a contract, and ignored when there is none.
  serviceCovered: boolean;
};

export function resolveSettlementPath(query: SettlementQuery): SettlementPath {
  // A FLEET IS A FLEET WHETHER OR NOT THIS PARTICULAR SERVICE IS COVERED.
  // An uncovered service on a fleet contract is an invoice line the fleet
  // argues about at month end — it is not a moment to ask a stranded fleet
  // driver for a card, and they would not have one to give.
  if (query.tenantKind === 'FLEET' && query.hasActiveContract) return 'FLEET_TENANT';

  // A consumer with cover for THIS service pays nothing. Without cover — or
  // with a contract that does not extend to what has gone wrong — they are a
  // walk-in for this job, which is exactly what "covered services" means.
  if (query.hasActiveContract && query.serviceCovered) return 'CONTRACT_CONSUMER';

  return 'WALK_IN';
}

// Whether this path ever contacts a payment provider. Two of the three do not,
// and phrasing it as a question rather than as `path === 'WALK_IN'` at four
// call sites means adding a fourth path later is one edit.
export function usesGateway(path: SettlementPath): boolean {
  return path === 'WALK_IN';
}
