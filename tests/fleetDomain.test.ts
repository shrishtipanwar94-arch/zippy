// PHASE 21 — the pure arithmetic behind the fleet dashboard and the intake
// prior. No database: src/domain/fleetSlaOutcome.ts, fleetMetrics.ts,
// repeatPattern.ts and fleetPrior.ts all take plain data and return plain
// data, which is what this file exercises directly.

import { describe, expect, it } from 'vitest';
import { slaOutcomeFor } from '../src/domain/fleetSlaOutcome.js';
import {
  currentExposurePaise,
  isActive,
  meanResolutionSummary,
  slaMetSummary,
  spendPaiseThisMonth,
  startOfMonthUtc,
} from '../src/domain/fleetMetrics.js';
import type { Incident } from '../src/domain/fleetMetrics.js';
import { repeatPatternFlag, REPEAT_PATTERN_MIN_COUNT, REPEAT_PATTERN_WINDOW_DAYS } from '../src/domain/repeatPattern.js';
import { fleetVehiclePrior, MAX_PRIOR_INCIDENTS } from '../src/domain/fleetPrior.js';
import { FAULT_PRIORS } from '../src/domain/faults.js';
import { shannonEntropy } from '../src/domain/entropy.js';

const NOW = new Date('2026-06-15T12:00:00Z');

// ---------------------------------------------------------------------------

describe('slaOutcomeFor — one incident, one of four answers', () => {
  it('has no contract window to measure', () => {
    expect(
      slaOutcomeFor({ createdAt: NOW, responseMinutes: null, arrivedAt: null, now: NOW }),
    ).toBe('NOT_APPLICABLE');
  });

  it('is still open, nobody there yet, deadline not reached', () => {
    const createdAt = new Date(NOW.getTime() - 10 * 60_000);
    expect(
      slaOutcomeFor({ createdAt, responseMinutes: 30, arrivedAt: null, now: NOW }),
    ).toBe('UNDECIDED');
  });

  it('the window closed with nobody there — a decided breach', () => {
    const createdAt = new Date(NOW.getTime() - 40 * 60_000);
    expect(
      slaOutcomeFor({ createdAt, responseMinutes: 30, arrivedAt: null, now: NOW }),
    ).toBe('BREACHED');
  });

  it('arrived inside the window — met', () => {
    const createdAt = new Date(NOW.getTime() - 40 * 60_000);
    const arrivedAt = new Date(NOW.getTime() - 20 * 60_000);
    expect(
      slaOutcomeFor({ createdAt, responseMinutes: 30, arrivedAt, now: NOW }),
    ).toBe('MET');
  });

  it('arrived after the deadline had already passed — breached', () => {
    const createdAt = new Date(NOW.getTime() - 40 * 60_000);
    const arrivedAt = new Date(NOW.getTime() - 5 * 60_000);
    expect(
      slaOutcomeFor({ createdAt, responseMinutes: 30, arrivedAt, now: NOW }),
    ).toBe('BREACHED');
  });

  it('arriving at the exact deadline counts as met, not breached', () => {
    const createdAt = new Date('2026-06-15T11:00:00Z');
    const arrivedAt = new Date('2026-06-15T11:30:00Z');
    expect(
      slaOutcomeFor({ createdAt, responseMinutes: 30, arrivedAt, now: NOW }),
    ).toBe('MET');
  });
});

// ---------------------------------------------------------------------------

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    jobId: 'job-1',
    status: 'INTAKE',
    createdAt: NOW,
    resolvedAt: null,
    responseMinutes: null,
    breachPenaltyPaise: 0,
    arrivedAt: null,
    approvedTotalPaise: null,
    ...overrides,
  };
}

describe('isActive / startOfMonthUtc', () => {
  it('terminal statuses are not active, everything else is', () => {
    expect(isActive('RESOLVED')).toBe(false);
    expect(isActive('UNSERVICEABLE')).toBe(false);
    expect(isActive('CANCELLED')).toBe(false);
    expect(isActive('EN_ROUTE')).toBe(true);
    expect(isActive('DRAFT')).toBe(true);
  });

  it('is the first instant of the UTC calendar month', () => {
    expect(startOfMonthUtc(new Date('2026-06-15T23:59:59Z')).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});

describe('slaMetSummary — decided jobs only, this month', () => {
  it('is null with no decided jobs at all', () => {
    const undecided = incident({ createdAt: NOW, responseMinutes: 30, arrivedAt: null });
    expect(slaMetSummary([undecided], NOW).metPercent).toBeNull();
  });

  it('excludes a job still comfortably inside its window from the denominator', () => {
    const decided = incident({
      jobId: 'decided',
      createdAt: new Date(NOW.getTime() - 40 * 60_000),
      responseMinutes: 30,
      arrivedAt: null, // breached
    });
    const stillOpen = incident({
      jobId: 'open',
      createdAt: new Date(NOW.getTime() - 5 * 60_000),
      responseMinutes: 30,
      arrivedAt: null,
    });

    const summary = slaMetSummary([decided, stillOpen], NOW);
    expect(summary.decidedCount).toBe(1);
    expect(summary.metPercent).toBe(0);
  });

  it('computes a real percentage over a mix of met and breached', () => {
    const met = incident({
      jobId: 'met',
      createdAt: new Date(NOW.getTime() - 40 * 60_000),
      responseMinutes: 30,
      arrivedAt: new Date(NOW.getTime() - 20 * 60_000),
    });
    const breached = incident({
      jobId: 'breached',
      createdAt: new Date(NOW.getTime() - 40 * 60_000),
      responseMinutes: 30,
      arrivedAt: null,
    });

    const summary = slaMetSummary([met, breached], NOW);
    expect(summary.decidedCount).toBe(2);
    expect(summary.metCount).toBe(1);
    expect(summary.metPercent).toBe(50);
  });

  it('ignores jobs raised in an earlier month', () => {
    const lastMonth = incident({
      createdAt: new Date('2026-05-01T09:00:00Z'),
      responseMinutes: 30,
      arrivedAt: null,
    });
    expect(slaMetSummary([lastMonth], NOW).decidedCount).toBe(0);
  });
});

describe('currentExposurePaise — active incidents whose window has already closed', () => {
  it('is zero with nothing breached', () => {
    const stillOpen = incident({ createdAt: NOW, responseMinutes: 30, breachPenaltyPaise: 250_000 });
    expect(currentExposurePaise([stillOpen], NOW)).toBe(0);
  });

  it('sums the penalty for active jobs past their deadline with nobody arrived', () => {
    const breachedA = incident({
      jobId: 'a',
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      responseMinutes: 30,
      breachPenaltyPaise: 250_000,
      status: 'PLANNED',
    });
    const breachedB = incident({
      jobId: 'b',
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      responseMinutes: 30,
      breachPenaltyPaise: 80_000,
      status: 'EN_ROUTE',
    });
    expect(currentExposurePaise([breachedA, breachedB], NOW)).toBe(330_000);
  });

  it('excludes a breach on a job that is no longer active', () => {
    const resolvedLate = incident({
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      responseMinutes: 30,
      breachPenaltyPaise: 250_000,
      status: 'RESOLVED',
      arrivedAt: new Date(NOW.getTime() - 5 * 60_000), // arrived, but late
    });
    expect(currentExposurePaise([resolvedLate], NOW)).toBe(0);
  });
});

describe('meanResolutionSummary and spendPaiseThisMonth — the same jobs, two numbers', () => {
  it('is null / zero with nothing resolved', () => {
    expect(meanResolutionSummary([], NOW)).toEqual({ meanMinutes: null, resolvedCount: 0 });
    expect(spendPaiseThisMonth([], NOW)).toBe(0);
  });

  it('averages resolution time and sums spend over the same resolved-this-month jobs', () => {
    const a = incident({
      jobId: 'a',
      status: 'RESOLVED',
      createdAt: new Date('2026-06-01T09:00:00Z'),
      resolvedAt: new Date('2026-06-01T10:00:00Z'), // 60 minutes
      approvedTotalPaise: 100_000,
    });
    const b = incident({
      jobId: 'b',
      status: 'RESOLVED',
      createdAt: new Date('2026-06-05T09:00:00Z'),
      resolvedAt: new Date('2026-06-05T09:30:00Z'), // 30 minutes
      approvedTotalPaise: 50_000,
    });
    // A job resolved last month must not leak into this month's numbers.
    const lastMonth = incident({
      jobId: 'c',
      status: 'RESOLVED',
      createdAt: new Date('2026-05-01T09:00:00Z'),
      resolvedAt: new Date('2026-05-01T09:10:00Z'),
      approvedTotalPaise: 999_999,
    });

    const resolution = meanResolutionSummary([a, b, lastMonth], NOW);
    expect(resolution.resolvedCount).toBe(2);
    expect(resolution.meanMinutes).toBe(45);
    expect(spendPaiseThisMonth([a, b, lastMonth], NOW)).toBe(150_000);
  });

  it('treats a resolved job with nothing approved as zero spend, not an error', () => {
    const noEstimate = incident({
      status: 'RESOLVED',
      createdAt: new Date('2026-06-01T09:00:00Z'),
      resolvedAt: new Date('2026-06-01T09:10:00Z'),
      approvedTotalPaise: null,
    });
    expect(spendPaiseThisMonth([noEstimate], NOW)).toBe(0);
  });
});

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
