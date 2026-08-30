// src/engine/cost.ts and src/engine/ranking.ts.
//
// The three assertions the build plan names are the spine of this file:
// the 7km broad-capability unit beats the 2km jump-starter-only unit on
// expected resolution; flipping the job to HIGH_RISK reverses the ranking;
// changing the weight vector changes the ranking. Everything else here exists
// to make those three unambiguous — a scenario where the "right" answer is
// obvious for the wrong reason proves nothing.

import { describe, expect, it } from 'vitest';
import {
  WEIGHT_VECTORS,
  capabilityShortfallRisk,
  expectedTimeToResolutionMinutes,
  operationalCostPaise,
  scoreOption,
  slaRisk,
} from '../src/engine/cost.js';
import { comparatorFor, rankOptions } from '../src/engine/ranking.js';
import type { DispatchOption, JobForDispatch } from '../src/engine/candidates.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';
import {
  REDISPATCH_COORDINATION_MINUTES,
  SECOND_DISPATCH_TRAVEL_MINUTES,
  diagnoseMinutes,
  escalationMinutes,
  resolveMinutes,
} from '../src/engine/durations.js';

const NOW = new Date('2026-06-01T09:00:00Z');

function distribution(weights: Partial<FaultDistribution>): FaultDistribution {
  const full = {} as FaultDistribution;
  for (const fault of FAULT_CODES) full[fault] = weights[fault] ?? 0;
  return full;
}

function job(overrides: Partial<JobForDispatch> = {}): JobForDispatch {
  return {
    id: 'job-1',
    lat: 12.9352,
    lng: 77.6245,
    faultDistribution: distribution({ FLAT_BATTERY: 1 }),
    createdAt: NOW,
    slaResponseMinutes: null,
    parkingLevel: null,
    onHighway: false,
    safetyLevel: 'NORMAL',
    ...overrides,
  };
}

function option(overrides: Partial<DispatchOption> = {}): DispatchOption {
  return {
    unitId: 'unit-1',
    technicianId: 'tech-1',
    estimatedTravelMinutes: 10,
    travelEstimateDegraded: false,
    estimatedTravelKm: 5,
    resolvableFaults: ['FLAT_BATTERY'],
    coveredFaultProbability: 1,
    missingCapabilities: [],
    ...overrides,
  };
}

// THE SCENARIO THE BUILD PLAN NAMES. A genuinely uncertain diagnosis — half
// flat battery (a jump start), half failed battery (a replacement) — is what
// makes capability matter at all. Against a certain diagnosis the nearest
// capable unit simply wins, and there is nothing to demonstrate.
const UNCERTAIN_BATTERY = distribution({ FLAT_BATTERY: 0.5, FAILED_BATTERY: 0.5 });

// 2km away, ~6 minutes. Can jump-start only — half the probability mass ends
// in a second dispatch.
const NEAR_NARROW = option({
  unitId: 'near-narrow',
  technicianId: 'tech-near',
  estimatedTravelMinutes: 6,
  estimatedTravelKm: 2,
  resolvableFaults: ['FLAT_BATTERY'],
  coveredFaultProbability: 0.5,
});

// 7km away, ~20 minutes. Can do both — nothing escalates.
const FAR_BROAD = option({
  unitId: 'far-broad',
  technicianId: 'tech-far',
  estimatedTravelMinutes: 20,
  estimatedTravelKm: 7,
  resolvableFaults: ['FLAT_BATTERY', 'FAILED_BATTERY'],
  coveredFaultProbability: 1,
});

describe('expectedTimeToResolution', () => {
  it('matches the formula computed by hand, term by term', () => {
    const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });

    // 0.5 × [travel + diagnose(FLAT) + resolve(FLAT)]
    //   + 0.5 × [travel + diagnose(FAILED) + escalation(FAILED)]
    const expected =
      0.5 * (6 + diagnoseMinutes('FLAT_BATTERY') + resolveMinutes('FLAT_BATTERY')) +
      0.5 * (6 + diagnoseMinutes('FAILED_BATTERY') + escalationMinutes('FAILED_BATTERY'));

    expect(expectedTimeToResolutionMinutes(NEAR_NARROW, uncertainJob)).toBeCloseTo(expected, 10);
  });

  // THE BUILD PLAN'S FIRST NAMED CHECK.
  it('the 7km broad-capability unit beats the 2km jump-starter-only unit', () => {
    const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });

    const near = expectedTimeToResolutionMinutes(NEAR_NARROW, uncertainJob);
    const far = expectedTimeToResolutionMinutes(FAR_BROAD, uncertainJob);

    // The far unit is genuinely further away — the win is not proximity.
    expect(FAR_BROAD.estimatedTravelMinutes).toBeGreaterThan(NEAR_NARROW.estimatedTravelMinutes);
    // But it expects to have the vehicle FIXED sooner.
    expect(far).toBeLessThan(near);
  });

  it('escalation is per-fault, not one flat penalty', () => {
    // The only thing that differs between these two jobs is WHICH fault the
    // unit cannot handle. If escalation were a constant, both would score the
    // same.
    const cannotDoEv = option({ resolvableFaults: [], coveredFaultProbability: 0 });
    const evJob = job({ faultDistribution: distribution({ EV_HV_FAULT: 1 }) });
    const tyreJob = job({ faultDistribution: distribution({ FLAT_TYRE: 1 }) });

    const evTime = expectedTimeToResolutionMinutes(cannotDoEv, evJob);
    const tyreTime = expectedTimeToResolutionMinutes(cannotDoEv, tyreJob);

    expect(evTime).not.toBeCloseTo(tyreTime, 5);
    expect(evTime).toBeGreaterThan(tyreTime);
  });

  it('escalation is built from a real second dispatch, not a magic number', () => {
    // Wait for a new unit, its travel, its resolve time — the three parts the
    // build plan names, recomposed independently here.
    expect(escalationMinutes('FLAT_TYRE')).toBeCloseTo(
      REDISPATCH_COORDINATION_MINUTES + SECOND_DISPATCH_TRAVEL_MINUTES + resolveMinutes('FLAT_TYRE'),
      10,
    );
  });

  it('a pair that can resolve everything is never charged an escalation', () => {
    const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });
    const expectedWithoutEscalation =
      0.5 * (20 + diagnoseMinutes('FLAT_BATTERY') + resolveMinutes('FLAT_BATTERY')) +
      0.5 * (20 + diagnoseMinutes('FAILED_BATTERY') + resolveMinutes('FAILED_BATTERY'));

    expect(expectedTimeToResolutionMinutes(FAR_BROAD, uncertainJob)).toBeCloseTo(
      expectedWithoutEscalation,
      10,
    );
  });
});

describe('capabilityShortfallRisk', () => {
  it('is the probability mass the pair cannot resolve', () => {
    const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });

    expect(capabilityShortfallRisk(NEAR_NARROW, uncertainJob)).toBeCloseTo(0.5, 10);
    expect(capabilityShortfallRisk(FAR_BROAD, uncertainJob)).toBeCloseTo(0, 10);
  });
});

describe('slaRisk', () => {
  it('is zero when no contract sets a response window', () => {
    expect(slaRisk(NEAR_NARROW, job({ slaResponseMinutes: null }), NOW)).toBe(0);
  });

  it('rises as arrival consumes more of the remaining window', () => {
    const roomy = job({ slaResponseMinutes: 60 });
    const tight = job({ slaResponseMinutes: 10 });

    expect(slaRisk(NEAR_NARROW, roomy, NOW)).toBeCloseTo(6 / 60, 10);
    expect(slaRisk(NEAR_NARROW, tight, NOW)).toBeCloseTo(6 / 10, 10);
    expect(slaRisk(NEAR_NARROW, tight, NOW)).toBeGreaterThan(slaRisk(NEAR_NARROW, roomy, NOW));
  });

  it('accounts for time already elapsed since the job was raised', () => {
    const raisedEarlier = job({ createdAt: new Date(NOW.getTime() - 30 * 60_000), slaResponseMinutes: 60 });
    // 30 of the 60 minutes are already gone, so 6 minutes of travel is 6/30.
    expect(slaRisk(NEAR_NARROW, raisedEarlier, NOW)).toBeCloseTo(6 / 30, 10);
  });

  it('saturates at 1 rather than exceeding it', () => {
    const alreadyBreached = job({ createdAt: new Date(NOW.getTime() - 90 * 60_000), slaResponseMinutes: 60 });
    expect(slaRisk(NEAR_NARROW, alreadyBreached, NOW)).toBe(1);
  });
});

describe('operationalCost', () => {
  it('grows with both distance driven and expected time on the job', () => {
    const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });
    const nearer = operationalCostPaise(option({ estimatedTravelKm: 2 }), uncertainJob);
    const further = operationalCostPaise(option({ estimatedTravelKm: 20 }), uncertainJob);

    expect(further).toBeGreaterThan(nearer);
    expect(Number.isFinite(nearer)).toBe(true);
  });
});

describe('CostBreakdown', () => {
  it('returns every term with its raw value, unit, weight and contribution', () => {
    const breakdown = scoreOption(NEAR_NARROW, job({ faultDistribution: UNCERTAIN_BATTERY }), NOW);

    expect(breakdown.expectedTimeToResolution.unit).toBe('minutes');
    expect(breakdown.travelDistance.unit).toBe('kilometres');
    expect(breakdown.capabilityShortfallRisk.unit).toBe('probability');
    expect(breakdown.slaRisk.unit).toBe('probability');
    expect(breakdown.operationalCost.unit).toBe('paise');
    expect(breakdown.weightVector).toBe('BALANCED');
  });

  it('has a total that is exactly the sum of the term contributions', () => {
    const breakdown = scoreOption(NEAR_NARROW, job({ faultDistribution: UNCERTAIN_BATTERY }), NOW);
    const summed =
      breakdown.expectedTimeToResolution.contribution +
      breakdown.travelDistance.contribution +
      breakdown.capabilityShortfallRisk.contribution +
      breakdown.slaRisk.contribution +
      breakdown.operationalCost.contribution;

    expect(breakdown.total).toBeCloseTo(summed, 10);
  });

  it('each contribution is its raw value times its weight', () => {
    const breakdown = scoreOption(NEAR_NARROW, job({ faultDistribution: UNCERTAIN_BATTERY }), NOW);

    expect(breakdown.travelDistance.value).toBe(2);
    expect(breakdown.travelDistance.weight).toBe(WEIGHT_VECTORS.BALANCED.travelDistance);
    expect(breakdown.travelDistance.contribution).toBeCloseTo(
      2 * WEIGHT_VECTORS.BALANCED.travelDistance,
      10,
    );
  });
});

describe('ranking', () => {
  const uncertainJob = job({ faultDistribution: UNCERTAIN_BATTERY });

  it('puts the broad-capability unit first under BALANCED weights', () => {
    const ranked = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'BALANCED');
    expect(ranked[0]!.option.unitId).toBe('far-broad');
  });

  // THE BUILD PLAN'S THIRD NAMED CHECK. LOWEST_COST cares about kilometres
  // and paise, and is willing to accept the re-dispatch risk the broad unit
  // avoids — so the same two options rank the other way round.
  it('changing the weight vector changes the ranking', () => {
    const balanced = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'BALANCED');
    const cheapest = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'LOWEST_COST');

    expect(balanced[0]!.option.unitId).toBe('far-broad');
    expect(cheapest[0]!.option.unitId).toBe('near-narrow');
    expect(balanced[0]!.option.unitId).not.toBe(cheapest[0]!.option.unitId);
  });

  it('FASTEST_RESOLUTION also prefers the broad unit, and by a wider margin', () => {
    const balanced = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'BALANCED');
    const fastest = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'FASTEST_RESOLUTION');

    expect(fastest[0]!.option.unitId).toBe('far-broad');
    const balancedMargin = balanced[1]!.cost.total - balanced[0]!.cost.total;
    const fastestMargin = fastest[1]!.cost.total - fastest[0]!.cost.total;
    expect(fastestMargin).toBeGreaterThan(balancedMargin);
  });

  // THE BUILD PLAN'S SECOND NAMED CHECK, and invariant 4 in one assertion.
  it('flipping the job to HIGH_RISK reverses the ranking', () => {
    const normal = rankOptions([NEAR_NARROW, FAR_BROAD], uncertainJob, NOW, 'BALANCED');
    const highRisk = rankOptions(
      [NEAR_NARROW, FAR_BROAD],
      job({ faultDistribution: UNCERTAIN_BATTERY, safetyLevel: 'HIGH_RISK' }),
      NOW,
      'BALANCED',
    );

    expect(normal[0]!.option.unitId).toBe('far-broad');
    expect(highRisk[0]!.option.unitId).toBe('near-narrow');
  });

  it('a HIGH_RISK job orders by arrival even when cost strongly disagrees', () => {
    // Make the near unit's cost as bad as this scenario allows — it still has
    // to win, because arrival is compared FIRST and no cost total can reach
    // past a lexicographic comparison.
    const highRisk = job({ faultDistribution: UNCERTAIN_BATTERY, safetyLevel: 'HIGH_RISK' });
    const ranked = rankOptions([FAR_BROAD, NEAR_NARROW], highRisk, NOW, 'FASTEST_RESOLUTION');

    expect(ranked[0]!.option.unitId).toBe('near-narrow');
    // And it genuinely IS the more expensive option — the comparator overrode
    // a real cost difference, it did not merely agree with it.
    expect(ranked[0]!.cost.total).toBeGreaterThan(ranked[1]!.cost.total);
  });

  // THE TEST THAT DISTINGUISHES A COMPARATOR FROM A BIG PENALTY, and the one
  // that matters most for invariant 4. Every other HIGH_RISK test above can
  // be satisfied by a large enough weighted arrival term — the penalty simply
  // agrees with the lexicographic answer when arrival gaps are wide. Here the
  // gap is deliberately TINY (30 seconds) and the cost gap enormous: the
  // slower unit resolves an EV fault outright, the faster one escalates it.
  // Any weighted arrival term small enough to be a "term" is outvoted by that
  // cost difference and picks the slower unit; a true lexicographic
  // comparator cannot be, and picks the faster one. This is invariant 3's
  // argument applied one level up, and it was found by mutating the
  // comparator into a penalty and watching every other test still pass.
  it('a HIGH_RISK job prefers a 30-seconds-sooner arrival over a vastly better cost', () => {
    const evJob = job({
      faultDistribution: distribution({ EV_HV_FAULT: 1 }),
      safetyLevel: 'HIGH_RISK',
    });

    const marginallyFasterButUseless = option({
      unitId: 'fast-useless',
      estimatedTravelMinutes: 10,
      estimatedTravelKm: 5,
      resolvableFaults: [],
      coveredFaultProbability: 0,
    });
    const slightlySlowerAndPerfect = option({
      unitId: 'slow-capable',
      estimatedTravelMinutes: 10.5,
      estimatedTravelKm: 5,
      resolvableFaults: ['EV_HV_FAULT'],
      coveredFaultProbability: 1,
    });

    const options = [slightlySlowerAndPerfect, marginallyFasterButUseless];
    const highRisk = rankOptions(options, evJob, NOW, 'FASTEST_RESOLUTION');
    const normal = rankOptions(options, job({ ...evJob, safetyLevel: 'NORMAL' }), NOW, 'FASTEST_RESOLUTION');

    // Under normal ordering the capable unit obviously wins on cost.
    expect(normal[0]!.option.unitId).toBe('slow-capable');
    // Under HIGH_RISK the sooner arrival wins anyway — by 30 seconds, against
    // a cost difference many times larger than any arrival weight would be.
    expect(highRisk[0]!.option.unitId).toBe('fast-useless');

    const costGap = highRisk[0]!.cost.total - highRisk[1]!.cost.total;
    const arrivalGap =
      highRisk[0]!.option.estimatedTravelMinutes - highRisk[1]!.option.estimatedTravelMinutes;
    // The winning option is worse on cost and better on arrival — proving the
    // comparison happened on arrival alone, not on a blend of the two.
    expect(costGap).toBeGreaterThan(0);
    expect(arrivalGap).toBeLessThan(0);
  });

  it('ELEVATED is not HIGH_RISK — only HIGH_RISK switches the ordering', () => {
    const elevated = rankOptions(
      [NEAR_NARROW, FAR_BROAD],
      job({ faultDistribution: UNCERTAIN_BATTERY, safetyLevel: 'ELEVATED' }),
      NOW,
      'BALANCED',
    );
    expect(elevated[0]!.option.unitId).toBe('far-broad');
  });

  it('picks the comparator from the job, not from the options', () => {
    expect(comparatorFor(job({ safetyLevel: 'HIGH_RISK' }))).not.toBe(
      comparatorFor(job({ safetyLevel: 'NORMAL' })),
    );
  });

  it('is deterministic for identical options, so a seeded replay ranks the same', () => {
    const twinA = option({ unitId: 'aaa', technicianId: 't1' });
    const twinB = option({ unitId: 'bbb', technicianId: 't2' });

    const first = rankOptions([twinB, twinA], uncertainJob, NOW, 'BALANCED');
    const second = rankOptions([twinA, twinB], uncertainJob, NOW, 'BALANCED');

    expect(first.map((s) => s.option.unitId)).toEqual(second.map((s) => s.option.unitId));
    expect(first[0]!.option.unitId).toBe('aaa');
  });

  it('does not mutate the array it was given', () => {
    const input = [NEAR_NARROW, FAR_BROAD];
    rankOptions(input, uncertainJob, NOW, 'BALANCED');
    expect(input[0]!.unitId).toBe('near-narrow');
  });
});
