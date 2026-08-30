// THE COST FUNCTION — the project's thesis expressed as arithmetic.
//
//   cost = w1·expectedTimeToResolution + w2·travelDistance
//        + w3·capabilityShortfallRisk  + w4·slaRisk + w5·operationalCost
//
// EXPECTED TIME TO RESOLUTION IS THE WHOLE ARGUMENT. Every dispatch system
// can send the nearest van. This one asks a different question: given what we
// currently believe is wrong — a probability distribution, not a guess — how
// long until the vehicle is actually FIXED, including the real cost of being
// wrong about the diagnosis?
//
//   Σ over faults: P(fault) × [ travel + diagnose(fault)
//                             + (canResolve ? resolve(fault)
//                                           : escalation(fault)) ]
//
// `escalation` is the term that earns the argument, and it is COMPUTED, not
// guessed at — a second dispatch is a real sequence of real waits
// (coordination, a second unit's travel, that unit's repair time), and it
// differs per fault because the repair at the end of it does. See
// durations.ts. A flat "mis-dispatch penalty" would say the same thing about
// sending the wrong van to a tyre change and to a high-voltage fault, and
// those are not the same mistake.
//
// EVERY TERM IS RETURNED, NOT JUST THE TOTAL. A bare number cannot be
// argued with: an operator looking at a ranked list needs to see that this
// unit won on expected resolution and lost on distance, not just that it
// scored 44.2. The whole CostBreakdown is stored on the DecisionRecord and
// rendered in the "Why this technician?" panel.
//
// WHAT IS DELIBERATELY NOT IN THIS FILE:
//   * The lexicographic ordering invariant 4 requires — it wraps the ranking
//     rather than joining it as a weighted term, and lives in ranking.ts.
//     A term can always be outweighed by other terms; that is exactly what a
//     term IS. Invariant 4 is not a preference to be traded against cost.
//   * Even distribution of work across technicians. Not a cost input at all —
//     it is measured as a secondary outcome of a whole simulated run at
//     Phase 10, because it is a property of a sequence of decisions, not of
//     any single one.
//   * Hard constraints. Those are filters and already ran (feasibility.ts).
//     Anything reaching this function is a legal option; cost only orders it.

import type { FaultCode } from '../domain/faults.js';
import { FAULT_CODES } from '../domain/faults.js';
import type { DispatchOption, JobForDispatch } from './candidates.js';
import { diagnoseMinutes, escalationMinutes, resolveMinutes } from './durations.js';

// ---------------------------------------------------------------------------
// Money constants. Paise, integer, per the project's money rule — never a
// float rupee. Plausible Indian service-fleet figures, not measured ones.
const FUEL_AND_WEAR_PAISE_PER_KM = 1_200; // ~Rs 12/km all-in for a service van
const LABOUR_PAISE_PER_MINUTE = 500; // ~Rs 300/hour of a technician's time

// ---------------------------------------------------------------------------
// Weights.
//
// THE UNITS DO NOT MATCH, AND THAT IS THE WEIGHTS' JOB. The five terms are
// measured in minutes, kilometres, two bare probabilities, and paise. A
// weight is therefore not a "how much do I care" dial on its own — it is that
// dial AND the conversion factor into a common scale. This is why the numbers
// below look so different in magnitude: 1.0 against a ~50-minute term and
// 0.0004 against a ~30,000-paise term are contributing comparably.
export type CostWeights = {
  expectedTimeToResolution: number;
  travelDistance: number;
  capabilityShortfallRisk: number;
  slaRisk: number;
  operationalCost: number;
};

export const WEIGHT_VECTORS = {
  // Optimise the thesis directly: get the vehicle fixed soonest, and treat
  // being unable to fix it as the expensive thing it is.
  FASTEST_RESOLUTION: {
    expectedTimeToResolution: 1.0,
    travelDistance: 0.1,
    capabilityShortfallRisk: 30,
    slaRisk: 20,
    operationalCost: 0.0001,
  },
  // Optimise what the run costs to operate: fuel, wear, paid time. Will
  // happily send a nearer, less capable unit and accept the re-dispatch risk.
  LOWEST_COST: {
    expectedTimeToResolution: 0.2,
    travelDistance: 2.0,
    capabilityShortfallRisk: 15,
    slaRisk: 10,
    operationalCost: 0.001,
  },
  // The default. Neither extreme; the vector a dispatcher sees first.
  BALANCED: {
    expectedTimeToResolution: 0.6,
    travelDistance: 0.8,
    capabilityShortfallRisk: 25,
    slaRisk: 20,
    operationalCost: 0.0004,
  },
} as const satisfies Record<string, CostWeights>;

export type WeightVectorName = keyof typeof WEIGHT_VECTORS;

// ---------------------------------------------------------------------------
// Output. One row per term, each carrying its raw value, the unit that value
// is in, the weight applied, and what it actually contributed to the total —
// so a UI can render the arithmetic rather than the answer.

export type CostTerm = {
  value: number;
  unit: 'minutes' | 'kilometres' | 'probability' | 'paise';
  weight: number;
  contribution: number;
};

export type CostBreakdown = {
  expectedTimeToResolution: CostTerm;
  travelDistance: CostTerm;
  capabilityShortfallRisk: CostTerm;
  slaRisk: CostTerm;
  operationalCost: CostTerm;
  total: number;
  weightVector: WeightVectorName;
};

// ---------------------------------------------------------------------------
// The differentiating term, written to read like the formula it implements.
export function expectedTimeToResolutionMinutes(
  option: DispatchOption,
  job: JobForDispatch,
): number {
  const resolvable = new Set(option.resolvableFaults);
  let expected = 0;

  for (const fault of FAULT_CODES) {
    const probability = job.faultDistribution[fault];
    if (probability <= 0) continue;

    const afterDiagnosis = resolvable.has(fault) ? resolveMinutes(fault) : escalationMinutes(fault);
    expected += probability * (option.estimatedTravelMinutes + diagnoseMinutes(fault) + afterDiagnosis);
  }

  return expected;
}

// Σ P(fault) × cannotResolve(fault) — the probability mass this pair would
// arrive unable to deal with. Deliberately NOT derived as
// `1 - coveredFaultProbability`: that identity holds only while the
// distribution sums to exactly 1, and a distribution that has drifted should
// produce a visibly odd risk rather than a silently plausible one.
export function capabilityShortfallRisk(option: DispatchOption, job: JobForDispatch): number {
  const resolvable = new Set<FaultCode>(option.resolvableFaults);
  let shortfall = 0;

  for (const fault of FAULT_CODES) {
    if (!resolvable.has(fault)) shortfall += job.faultDistribution[fault];
  }

  return shortfall;
}

// How much of the promised response window this arrival would eat. Not
// "would it breach" — feasibility already rejected the options that would
// (SLA_UNREACHABLE), so everything scored here fits, and what is left to
// express is that fitting with 30 seconds to spare is worse than fitting with
// twenty minutes to spare. 0 when no contract sets a window at all.
export function slaRisk(option: DispatchOption, job: JobForDispatch, now: Date): number {
  if (job.slaResponseMinutes === null) return 0;

  const elapsedMinutes = (now.getTime() - job.createdAt.getTime()) / 60_000;
  const remainingMinutes = job.slaResponseMinutes - elapsedMinutes;
  if (remainingMinutes <= 0) return 1;

  return Math.min(1, option.estimatedTravelMinutes / remainingMinutes);
}

// What the visit costs to run: fuel and wear over the road distance, plus
// paid technician time for however long the job is expected to take.
export function operationalCostPaise(option: DispatchOption, job: JobForDispatch): number {
  const drivingCost = FUEL_AND_WEAR_PAISE_PER_KM * option.estimatedTravelKm;
  const labourCost = LABOUR_PAISE_PER_MINUTE * expectedTimeToResolutionMinutes(option, job);
  return drivingCost + labourCost;
}

// ---------------------------------------------------------------------------
function term(value: number, unit: CostTerm['unit'], weight: number): CostTerm {
  return { value, unit, weight, contribution: value * weight };
}

export function scoreOption(
  option: DispatchOption,
  job: JobForDispatch,
  now: Date,
  weightVector: WeightVectorName = 'BALANCED',
): CostBreakdown {
  const weights = WEIGHT_VECTORS[weightVector];

  const breakdown = {
    expectedTimeToResolution: term(
      expectedTimeToResolutionMinutes(option, job),
      'minutes',
      weights.expectedTimeToResolution,
    ),
    travelDistance: term(option.estimatedTravelKm, 'kilometres', weights.travelDistance),
    capabilityShortfallRisk: term(
      capabilityShortfallRisk(option, job),
      'probability',
      weights.capabilityShortfallRisk,
    ),
    slaRisk: term(slaRisk(option, job, now), 'probability', weights.slaRisk),
    operationalCost: term(operationalCostPaise(option, job), 'paise', weights.operationalCost),
  };

  const total =
    breakdown.expectedTimeToResolution.contribution +
    breakdown.travelDistance.contribution +
    breakdown.capabilityShortfallRisk.contribution +
    breakdown.slaRisk.contribution +
    breakdown.operationalCost.contribution;

  return { ...breakdown, total, weightVector };
}
