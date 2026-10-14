// PHASE 21 — the pure arithmetic that outlived the fleet dashboard.
//
// The dashboard's own calculators (fleetSlaOutcome.ts, fleetMetrics.ts) went
// with the surface that displayed them. These two rules did not, because
// neither is about a dashboard: repeatPattern.ts is a recurrence rule over
// incident history, and fleetPrior.ts sharpens the fault distribution at
// intake before the first question is asked. No database — both take plain
// data and return plain data, which is what this file exercises directly.
//
// repeatPatternFlag currently has NO production caller. It is kept, and kept
// tested, because the rule is sound and a home for it is a separate decision.

import { describe, expect, it } from 'vitest';
import { repeatPatternFlag, REPEAT_PATTERN_MIN_COUNT, REPEAT_PATTERN_WINDOW_DAYS } from '../src/domain/repeatPattern.js';
import { fleetVehiclePrior, MAX_PRIOR_INCIDENTS } from '../src/domain/fleetPrior.js';
import { FAULT_PRIORS } from '../src/domain/faults.js';
import { shannonEntropy } from '../src/domain/entropy.js';

const NOW = new Date('2026-06-15T12:00:00Z');

// ---------------------------------------------------------------------------

describe('repeatPatternFlag — a rule, not a model', () => {
  it('is null below the threshold', () => {
    const incidents = [
      { fault: 'FLAT_BATTERY' as const, at: NOW },
      { fault: 'FLAT_BATTERY' as const, at: NOW },
    ];
    expect(repeatPatternFlag(incidents, NOW)).toBeNull();
  });

  it('flags the third same-fault incident inside the window', () => {
    const incidents = Array.from({ length: REPEAT_PATTERN_MIN_COUNT }, () => ({
      fault: 'FLAT_BATTERY' as const,
      at: NOW,
    }));
    const flag = repeatPatternFlag(incidents, NOW);
    expect(flag).not.toBeNull();
    expect(flag?.fault).toBe('FLAT_BATTERY');
    expect(flag?.count).toBe(REPEAT_PATTERN_MIN_COUNT);
    expect(flag?.message).toContain('3rd');
    expect(flag?.message).toContain('60 days');
    expect(flag?.message).toContain('Not a dispatch problem');
  });

  it('does not count an incident outside the trailing window', () => {
    const old = new Date(NOW.getTime() - (REPEAT_PATTERN_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    const incidents = [
      { fault: 'FLAT_BATTERY' as const, at: old },
      { fault: 'FLAT_BATTERY' as const, at: NOW },
      { fault: 'FLAT_BATTERY' as const, at: NOW },
    ];
    expect(repeatPatternFlag(incidents, NOW)).toBeNull();
  });

  it('reports only the worst pattern when a vehicle has more than one', () => {
    const incidents = [
      ...Array.from({ length: 3 }, () => ({ fault: 'FLAT_BATTERY' as const, at: NOW })),
      ...Array.from({ length: 4 }, () => ({ fault: 'FLAT_TYRE' as const, at: NOW })),
    ];
    const flag = repeatPatternFlag(incidents, NOW);
    expect(flag?.fault).toBe('FLAT_TYRE');
    expect(flag?.count).toBe(4);
  });
});

// ---------------------------------------------------------------------------

describe('fleetVehiclePrior — folds history in exactly like a symptom observation', () => {
  it('returns the baseline unchanged with no history', () => {
    expect(fleetVehiclePrior(FAULT_PRIORS, [])).toEqual(FAULT_PRIORS);
  });

  it('sharpens the prior toward a fault that keeps recurring', () => {
    const sharpened = fleetVehiclePrior(FAULT_PRIORS, ['FLAT_BATTERY', 'FLAT_BATTERY']);
    expect(sharpened.FLAT_BATTERY).toBeGreaterThan(FAULT_PRIORS.FLAT_BATTERY);
    // Still a real distribution.
    const total = Object.values(sharpened).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('is strictly less uncertain with two matching prior incidents than with none', () => {
    const baseline = shannonEntropy(FAULT_PRIORS);
    const sharpened = fleetVehiclePrior(FAULT_PRIORS, ['FLAT_BATTERY', 'FLAT_BATTERY']);
    expect(shannonEntropy(sharpened)).toBeLessThan(baseline);
  });

  it('only folds in the most recent MAX_PRIOR_INCIDENTS entries', () => {
    const many = Array(MAX_PRIOR_INCIDENTS + 10).fill('FLAT_BATTERY' as const);
    const capped = fleetVehiclePrior(FAULT_PRIORS, many);
    const exact = fleetVehiclePrior(FAULT_PRIORS, many.slice(0, MAX_PRIOR_INCIDENTS));
    expect(capped).toEqual(exact);
  });
});
