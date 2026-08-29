// SHANNON ENTROPY AND BAYES UPDATE — the two pieces of maths intake runs on.
//
// ENTROPY measures how uncertain a probability distribution is, in bits. A
// distribution that is certain (one fault at probability 1) has entropy 0. A
// distribution spread evenly over 12 faults has entropy log2(12) ≈ 3.58 bits —
// the most uncertain it can be. Intake asks questions until entropy is low
// enough, which is why "flat tyre" asks nothing and "won't start" asks several:
// the first symptom already produced a near-certain distribution, the second
// did not.
//
// BAYES UPDATE turns "what I believed before" plus "what I just observed" into
// "what I believe now": posterior ∝ prior × P(observation | fault). We multiply
// every fault's probability by how likely that observation would be if that
// fault were the true one, then normalise back to summing to 1.
//
// Pure functions over plain objects. No I/O, no database, no clock.

import { FAULT_CODES } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';

// Probabilities below this are treated as zero, so floating-point dust from
// repeated multiplication cannot register as a real possibility.
const NEGLIGIBLE = 1e-9;

export function shannonEntropy(distribution: FaultDistribution): number {
  let total = 0;
  for (const fault of FAULT_CODES) {
    const probability = distribution[fault];
    if (probability > NEGLIGIBLE) {
      total -= probability * Math.log2(probability);
    }
  }
  return total;
}

// Scales a set of non-negative weights so they sum to 1. If every weight is
// zero — an observation no fault can explain — the caller's prior is returned
// unchanged rather than producing NaN. Contradictory input must not destroy the
// distribution; it should just fail to narrow it.
export function normalise(
  weights: Record<FaultCode, number>,
  fallback: FaultDistribution,
): FaultDistribution {
  let sum = 0;
  for (const fault of FAULT_CODES) {
    sum += weights[fault];
  }
  if (sum <= NEGLIGIBLE) {
    return { ...fallback };
  }

  const normalised = {} as FaultDistribution;
  for (const fault of FAULT_CODES) {
    normalised[fault] = weights[fault] / sum;
  }
  return normalised;
}

// posterior ∝ prior × likelihood. `likelihood[fault]` is P(observation | fault):
// how likely this observation would be if that fault were the true one.
export function applyLikelihood(
  prior: FaultDistribution,
  likelihood: Record<FaultCode, number>,
): FaultDistribution {
  const weights = {} as Record<FaultCode, number>;
  for (const fault of FAULT_CODES) {
    weights[fault] = prior[fault] * likelihood[fault];
  }
  return normalise(weights, prior);
}

// The faults in descending probability order. Ties break on the fixed
// FAULT_CODES order so the result is deterministic — the evaluation harness in
// Phase 10 replays these runs and compares them.
export function rankFaults(distribution: FaultDistribution): FaultCode[] {
  const ranked = [...FAULT_CODES];
  ranked.sort((a, b) => {
    const difference = distribution[b] - distribution[a];
    if (difference !== 0) return difference;
    return FAULT_CODES.indexOf(a) - FAULT_CODES.indexOf(b);
  });
  return ranked;
}

export function topFault(distribution: FaultDistribution): FaultCode {
  return rankFaults(distribution)[0]!;
}
