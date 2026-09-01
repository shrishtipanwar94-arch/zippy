// THE FAULT HYPOTHESIS, AS ANYTHING OUTSIDE THE ENGINE SEES IT.
//
// One shape, two producers. The driver taps through the symptom picker, or the
// driver describes the breakdown in their own words and a model fills the same
// form in — and both arrive here and come out identical. That is the whole
// point of Phase 16: the AI replaces the INPUT to the rule table, never the
// table, so nothing downstream can tell which path a job took.
//
// PURE. No database, no clock, no network. `renormalised` is returned rather
// than logged because this file has no logger — the caller logs it, and the
// domain stays something a test can call with a literal.

import { classifySymptoms } from './faultRules.js';
import { capabilitiesForFault, partSkusForFault, FAULT_CODES } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';
import { rankFaults, shannonEntropy, topFault } from './entropy.js';
import { requiredCapabilities, contendingFaults } from './capabilitySet.js';
import type { SymptomPayload } from './symptoms.js';

// The capability that means "nothing roadside will fix this, it goes on a
// flatbed". Tow probability is the probability mass sitting on faults that
// need it — a derived number, not a second opinion.
const TOW_CAPABILITY = 'FLATBED_LOADING';

// Floating point sums of twelve terms do not land exactly on 1. Anything
// inside this is arithmetic; anything outside it is a producer that handed us
// a distribution which is not one, and the caller is told so.
const SUM_TOLERANCE = 1e-6;

export type HypothesisView = {
  faultDistribution: FaultDistribution;
  // Most likely first, so a UI can render the top three without sorting.
  rankedFaults: FaultCode[];
  topFault: FaultCode;
  entropyBits: number;
  requiredCapabilities: string[];
  // The SKUs a first visit would consume if the contending faults are right.
  // The estimate builder computes its own from the confirmed diagnosis; this
  // is the intake-time preview, and it is a union over contenders rather than
  // the top fault alone for the same reason the capability set is.
  requiredParts: string[];
  towProbability: number;
  urgencySignals: string[];
  vehicleContext: { make: string | null; model: string | null; fuel: string } | null;
  // True when the distribution handed in did not sum to 1 and had to be
  // rescaled. Always false for the rule table's own output; it exists because
  // a model-produced distribution is exactly the thing that would arrive at
  // 0.97 and quietly poison every ratio downstream.
  renormalised: boolean;
};

export type HypothesisViewInput = {
  symptoms: SymptomPayload;
  urgencySignals: string[];
  vehicleContext: HypothesisView['vehicleContext'];
};

export function buildHypothesisView(input: HypothesisViewInput): HypothesisView {
  const classified = classifySymptoms(input.symptoms);
  const { distribution, renormalised } = normaliseToOne(classified);

  return {
    faultDistribution: distribution,
    rankedFaults: rankFaults(distribution),
    topFault: topFault(distribution),
    entropyBits: shannonEntropy(distribution),
    requiredCapabilities: requiredCapabilities(distribution),
    requiredParts: contendingParts(distribution),
    towProbability: towProbability(distribution),
    urgencySignals: [...input.urgencySignals].sort(),
    vehicleContext: input.vehicleContext,
    renormalised,
  };
}

// The union of what the contending faults consume, de-duplicated and sorted so
// two views of the same distribution compare equal.
function contendingParts(distribution: FaultDistribution): string[] {
  const skus = new Set<string>();
  for (const fault of contendingFaults(distribution)) {
    for (const sku of partSkusForFault(fault)) {
      skus.add(sku);
    }
  }
  return [...skus].sort();
}

export function towProbability(distribution: FaultDistribution): number {
  let mass = 0;
  for (const fault of FAULT_CODES) {
    if (capabilitiesForFault(fault).includes(TOW_CAPABILITY)) {
      mass += distribution[fault];
    }
  }
  return mass;
}

// Rescale to sum 1, and say whether it had to. A distribution of all zeroes —
// which no producer here can make, but a stored blob could — falls back to
// uniform rather than dividing by zero.
export function normaliseToOne(distribution: FaultDistribution): {
  distribution: FaultDistribution;
  renormalised: boolean;
} {
  let total = 0;
  for (const fault of FAULT_CODES) {
    total += Math.max(0, distribution[fault]);
  }

  if (total <= 0) {
    const uniform = {} as FaultDistribution;
    for (const fault of FAULT_CODES) uniform[fault] = 1 / FAULT_CODES.length;
    return { distribution: uniform, renormalised: true };
  }

  if (Math.abs(total - 1) <= SUM_TOLERANCE) {
    return { distribution, renormalised: false };
  }

  const scaled = {} as FaultDistribution;
  for (const fault of FAULT_CODES) {
    scaled[fault] = Math.max(0, distribution[fault]) / total;
  }
  return { distribution: scaled, renormalised: true };
}
