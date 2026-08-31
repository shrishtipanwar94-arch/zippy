// WHAT A CONTRACT ABSORBS, AND WHAT IS LEFT FOR SOMEBODY TO PAY.
//
// Cover is not all-or-nothing. `covered_services.cap_paise` is a PER-INCIDENT
// LIMIT — a contract that covers roadside assistance up to ₹2,000 covers a
// ₹1,440 job entirely and leaves ₹340 of a ₹2,340 job for the driver. Until
// this file existed the cap was never read, which had two consequences worth
// separating:
//
//   the platform absorbed WITHOUT BOUND — a covered job of any size became a
//   `platform:coverage-cost` entry, so cover was effectively unlimited;
//
//   and the split could not be computed AT ALL, so the driver's estimate had
//   nowhere to get "covered −₹900 / payable ₹1,440" from and simply showed the
//   full total.
//
// The second is why the display gap and the cap gap were one job rather than
// two: you cannot show a split you have no cap to compute.
//
// PURE. Takes a total and the terms; returns the two halves. The terms are
// fetched by src/commit/settlement.ts, and WHICH accounts the two halves are
// booked to is src/domain/ledger.ts's business.

import type { Paise } from './money.js';

export type CoverageTerms = {
  // Whether the contract in force covers this job's service type at all.
  covered: boolean;
  // The per-incident limit. Null means covered with NO cap — genuinely
  // unlimited, which is a real contract term and is different from `covered:
  // false`. A cap of zero is also real and means the service is listed but
  // nothing is absorbed.
  capPaise: Paise | null;
};

export type CoverageSplit = {
  coveredPaise: Paise;
  payablePaise: Paise;
};

// The two always sum to the total. Nothing here can lose a paise, which is what
// makes the ledger and the driver's screen able to agree.
export function applyCoverage(totalPaise: Paise, terms: CoverageTerms): CoverageSplit {
  if (!terms.covered) return { coveredPaise: 0, payablePaise: totalPaise };

  if (terms.capPaise === null) {
    return { coveredPaise: totalPaise, payablePaise: 0 };
  }

  // THE CAP BITES HERE. Covered up to the limit; the overage is genuinely owed
  // by the driver, and is booked and shown as such.
  const coveredPaise = Math.min(totalPaise, Math.max(0, terms.capPaise));
  return { coveredPaise, payablePaise: totalPaise - coveredPaise };
}

// Whether the customer owes anything at all. Worth a name because it is the
// question the driver's screen asks — a fully covered job shows no payment
// affordance, not a payment affordance for zero.
export function isFullyCovered(split: CoverageSplit): boolean {
  return split.payablePaise === 0;
}
