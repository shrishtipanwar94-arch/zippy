// THE COST FUNCTION — the project's thesis expressed as arithmetic.
//
//   cost = w1·expectedTimeToResolution + w2·travelDistance
//        + w3·capabilityShortfallRisk  + w4·slaRisk + w5·operationalCost
//        + w6·partSourcingCost        + w7·contractSlaExposure
//        + w8·destinationRefusalRisk
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
import { avoidedBreachPenaltyPaise, remainingWindowMinutes } from '../domain/contractExposure.js';
import {
  DESTINATION_REFUSAL_MINUTES,
  diagnoseMinutes,
  escalationMinutes,
  resolveMinutes,
} from './durations.js';

// ---------------------------------------------------------------------------
// Money constants. Paise, integer, per the project's money rule — never a
// float rupee. Plausible Indian service-fleet figures, not measured ones.
const FUEL_AND_WEAR_PAISE_PER_KM = 1_200; // ~Rs 12/km all-in for a service van
const LABOUR_PAISE_PER_MINUTE = 500; // ~Rs 300/hour of a technician's time

// ---------------------------------------------------------------------------
// Weights.
//
// THE UNITS DO NOT MATCH, AND THAT IS THE WEIGHTS' JOB. The eight terms are
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
  partSourcingCost: number;
  contractSlaExposure: number;
  destinationRefusalRisk: number;
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
    // Almost indifferent to what a depot run costs: the detour's TIME is
    // already inside the expected-resolution term above, which is the term
    // this vector cares about, and the value of the part is not what a driver
    // on a roadside is waiting for.
    partSourcingCost: 0.00002,
    // The same weight BALANCED uses. This vector is already racing the clock
    // for every job, contract or not, so leaning further on the contract term
    // would buy very little and would quietly turn "fastest resolution" into
    // "fastest resolution for whoever pays".
    contractSlaExposure: 0.0004,
    // SAME WEIGHT AS expectedTimeToResolution, in every vector below as well
    // as this one — both terms are measured in minutes of expected delay, and
    // a refusal risk is exactly that: time this vector is already built to
    // hate losing.
    destinationRefusalRisk: 1.0,
  },
  // Optimise what the run costs to operate: fuel, wear, paid time. Will
  // happily send a nearer, less capable unit and accept the re-dispatch risk.
  LOWEST_COST: {
    expectedTimeToResolution: 0.2,
    travelDistance: 2.0,
    capabilityShortfallRisk: 15,
    slaRisk: 10,
    operationalCost: 0.001,
    // The vector that most dislikes sending a van across town for a part it
    // could have loaded this morning.
    partSourcingCost: 0.0002,
    // A breach penalty is money leaving the business exactly like fuel is, so
    // the vector that counts rupees counts these too — at the same weight it
    // gives operational cost, because they are the same currency and the same
    // ledger.
    contractSlaExposure: 0.001,
    destinationRefusalRisk: 0.2,
  },
  // The default. Neither extreme; the vector a dispatcher sees first.
  BALANCED: {
    expectedTimeToResolution: 0.6,
    travelDistance: 0.8,
    capabilityShortfallRisk: 25,
    slaRisk: 20,
    operationalCost: 0.0004,
    // A typical depot run — a mid-priced part plus twenty minutes of driving —
    // comes to roughly 260,000 paise, so this weight makes it worth about
    // thirteen points against a resolution term of forty or fifty. Enough to
    // lose to a van that already has the part, nowhere near enough to act as a
    // constraint: invariant 3 says a filter is a filter and a cost is a cost,
    // and a weight tuned until an option can never win has quietly become the
    // former.
    partSourcingCost: 0.00005,
    // A ₹2,500 GOLD penalty comfortably avoided is a 250,000-paise credit,
    // which this weight turns into a hundred points against option totals in
    // the forties. Deliberately large: a contract breach is the most expensive
    // single thing an ordinary shift can do. It is still a WEIGHT and can still
    // be outvoted — and it can never outvote safety, because safety is not in
    // this function at all.
    contractSlaExposure: 0.0004,
    destinationRefusalRisk: 0.6,
  },
  // PLAN C. The dispatcher's answer to "we cannot afford to breach MetroCab
  // again this month" — the same feasible options, with the contract term
  // dominating everything except the hard filters and the safety ordering.
  //
  // IT DEPRIORITISES CONSUMER JOBS AND THE UI SAYS SO. A consumer job this
  // plan leaves waiting that the recommended plan would have served is named
  // on the plan card before a dispatcher can take it
  // (src/domain/contractContention.ts, public/js/panels/plans.js). A
  // trade-off a tool makes silently is a trade-off nobody signed up for.
  PROTECT_CONTRACTS: {
    expectedTimeToResolution: 0.6,
    travelDistance: 0.8,
    capabilityShortfallRisk: 25,
    slaRisk: 20,
    operationalCost: 0.0004,
    partSourcingCost: 0.00005,
    // Ten times BALANCED. Everything else is BALANCED exactly, so the ONLY
    // difference between plan B and plan C is how much a contract promise is
    // worth — which is what makes the two cards comparable rather than two
    // unrelated opinions.
    contractSlaExposure: 0.004,
    destinationRefusalRisk: 0.6,
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
  partSourcingCost: CostTerm;
  contractSlaExposure: CostTerm;
  destinationRefusalRisk: CostTerm;
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
    // The detour to collect a part is time the driver spends waiting, so it
    // belongs in the term the project claims to optimise rather than only in
    // the money term. It is a property of the option, so multiplying it by
    // probabilities that sum to 1 adds it exactly once.
    const travel = option.estimatedTravelMinutes + option.partSourcing.detourMinutes;
    expected += probability * (travel + diagnoseMinutes(fault) + afterDiagnosis);
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

// WHAT GETTING THE PART COSTS: the detour, priced as paid technician time,
// plus the value of the stock the depot run draws down. Zero for a crew who
// already has everything on board, which is the whole point — it is the term
// that makes "the van three streets further away that is actually stocked"
// beat "the nearest van plus a trip across town".
//
// THE PART VALUE IS IN HERE ON PURPOSE, even though the same part gets
// consumed whichever crew fits it. What differs is WHOSE shelf it comes off:
// stock already sitting on a van is committed, and a depot run pulls a fresh
// unit out of inventory that some other job may need tomorrow. Pricing that
// draw-down is what stops the solver treating the depot as infinite.
export function partSourcingCostPaise(option: DispatchOption): number {
  const detourCost = LABOUR_PAISE_PER_MINUTE * option.partSourcing.detourMinutes;
  return detourCost + option.partSourcing.partValuePaise;
}

// HOW MUCH CONTRACT PENALTY THIS OPTION IS EXPOSED TO, in paise, MEASURED
// AGAINST NOBODY GOING — so it is zero or NEGATIVE, and the negative is a
// credit for the breach this dispatch avoids. src/domain/contractExposure.ts
// carries the full argument for the sign, which is not cosmetic: as a positive
// cost this term would make a GOLD job the expensive job and hand the last van
// to the consumer, and a heavier weight would make that worse.
//
// WHY A CONTRACT BELONGS IN THE OBJECTIVE WHEN AN EVEN SPREAD OF WORK DOES NOT:
// a breach penalty is a quantified obligation somebody signed, denominated in
// the same rupees the operational-cost term already trades in. How work is
// distributed across technicians is a policy preference with no defensible
// exchange rate against a stranded driver, so it stays a measured OUTCOME of a
// whole run (evaluation/metrics.ts) and never becomes a term here.
// src/domain/contractExposure.ts carries that argument in full.
//
// IT IS A WEIGHT AND CAN BE OUTVOTED, WHICH IS THE POINT. A ₹2,500 penalty at
// the BALANCED weight is worth about a hundred points against option totals in
// the forties, so a contract job usually does win a contested van — but an
// option a hundred points cheaper still beats it, and it can never touch the
// safety ordering, which is not in this function at all. A term tuned until it
// could never lose would be a constraint wearing a disguise (invariant 3), and
// the honest statement is that this one is large rather than absolute.
//
// THE DETOUR COUNTS. Arrival means arrival, so a crew diverting through a depot
// for a part is exposed to the same window as one driving straight there — the
// same number feasibility.ts uses for SLA_UNREACHABLE.
export function contractSlaExposure(option: DispatchOption, job: JobForDispatch, now: Date): number {
  if (job.slaResponseMinutes === null) return 0;

  const arrivalMinutes = option.estimatedTravelMinutes + option.partSourcing.detourMinutes;
  const remaining = remainingWindowMinutes(job.slaResponseMinutes, job.createdAt, now);
  return -avoidedBreachPenaltyPaise(job.contract, arrivalMinutes, remaining);
}

// WHAT A WORKSHOP SAYING NO WOULD COST, IN EXPECTATION — Phase 22. Zero for
// every option except a CHOSEN destination: not a tow (NOT_NEEDED), or a
// snapshot with no workshop data (NOT_MODELLED), both carry pAccept = 1 on
// their DestinationChoice for exactly this reason — "nothing being risked"
// has to compute to zero risk, not to an accidental one.
//
// THE SYSTEM NOW PREFERS WORKSHOPS THAT ACTUALLY SAY YES — the phase brief's
// own sentence, and this term is the whole mechanism: two options that are
// otherwise identical but which resolved to a nervous workshop and a
// reliable one no longer cost the same, because one of them is expected to
// bounce back through a re-solve and the other is not.
export function destinationRefusalRiskMinutes(option: DispatchOption): number {
  return (1 - option.destination.pAccept) * DESTINATION_REFUSAL_MINUTES;
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
    partSourcingCost: term(partSourcingCostPaise(option), 'paise', weights.partSourcingCost),
    contractSlaExposure: term(
      contractSlaExposure(option, job, now),
      'paise',
      weights.contractSlaExposure,
    ),
    destinationRefusalRisk: term(
      destinationRefusalRiskMinutes(option),
      'minutes',
      weights.destinationRefusalRisk,
    ),
  };

  const total =
    breakdown.expectedTimeToResolution.contribution +
    breakdown.travelDistance.contribution +
    breakdown.capabilityShortfallRisk.contribution +
    breakdown.slaRisk.contribution +
    breakdown.operationalCost.contribution +
    breakdown.partSourcingCost.contribution +
    breakdown.contractSlaExposure.contribution +
    breakdown.destinationRefusalRisk.contribution;

  return { ...breakdown, total, weightVector };
}
