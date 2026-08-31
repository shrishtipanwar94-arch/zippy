// The two pure policy modules the console renders: the priority ordering and
// the scarcity thresholds.
//
// Both are the kind of thing that looks obviously correct and is easy to
// break by refactoring into a score. The tests below are aimed at the
// MECHANISM rather than at plausible outputs — a weighted sum would pass a
// test that only checks a HIGH_RISK job comes first when everything else is
// equal, so the cases here make everything else deliberately unequal.

import { describe, expect, it } from 'vitest';
import {
  compareForQueue,
  orderQueue,
  slaRisk,
  ageMinutes,
  SAFETY_ORDER,
} from '../src/domain/priority.js';
import {
  classifyShare,
  summarise,
  byUrgency,
  RED_SHARE,
  AMBER_SHARE,
} from '../src/domain/scarcity.js';

const NOW = new Date('2026-06-01T12:00:00Z');

function job(overrides: Partial<Parameters<typeof slaRisk>[0]> = {}) {
  return {
    id: 'job-1',
    safetyLevel: 'NORMAL',
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    slaResponseMinutes: 60,
    ...overrides,
  };
}

describe('the priority queue is lexicographic, not weighted', () => {
  // THE TEST THAT PINS THE MECHANISM. A HIGH_RISK job that is brand new, with
  // an SLA barely touched, against a NORMAL job that is hours overdue. Any
  // weighted score with a realistic safety weight puts the overdue one first;
  // a tiered comparison cannot.
  it('puts a fresh HIGH_RISK job above a wildly overdue NORMAL one', () => {
    const dangerous = job({
      id: 'dangerous',
      safetyLevel: 'HIGH_RISK',
      createdAt: new Date(NOW.getTime() - 1 * 60_000),
      slaResponseMinutes: 60,
    });
    const overdue = job({
      id: 'overdue',
      safetyLevel: 'NORMAL',
      createdAt: new Date(NOW.getTime() - 600 * 60_000),
      slaResponseMinutes: 30,
    });

    // The overdue job is at 2000% of its window; the dangerous one at 1.7%.
    expect(slaRisk(overdue, NOW)).toBeGreaterThan(slaRisk(dangerous, NOW) * 100);
    expect(compareForQueue(dangerous, overdue, NOW)).toBeLessThan(0);
    expect(orderQueue([overdue, dangerous], NOW).map((row) => row.id)).toEqual([
      'dangerous',
      'overdue',
    ]);
  });

  it('falls to SLA risk only within one safety level', () => {
    const urgent = job({ id: 'urgent', createdAt: new Date(NOW.getTime() - 50 * 60_000) });
    const relaxed = job({ id: 'relaxed', createdAt: new Date(NOW.getTime() - 5 * 60_000) });

    expect(orderQueue([relaxed, urgent], NOW).map((row) => row.id)).toEqual(['urgent', 'relaxed']);
  });

  it('falls to age only when safety and SLA risk both tie', () => {
    // No SLA on either, so slaRisk is 0 for both and age is all that is left.
    const older = job({ id: 'older', slaResponseMinutes: null, createdAt: new Date(NOW.getTime() - 90 * 60_000) });
    const newer = job({ id: 'newer', slaResponseMinutes: null, createdAt: new Date(NOW.getTime() - 5 * 60_000) });

    expect(orderQueue([newer, older], NOW).map((row) => row.id)).toEqual(['older', 'newer']);
  });

  it('orders the three safety levels correctly', () => {
    const jobs = SAFETY_ORDER.map((level, index) =>
      job({ id: level, safetyLevel: level, createdAt: new Date(NOW.getTime() - index * 60_000) }),
    );
    expect(orderQueue([...jobs].reverse(), NOW).map((row) => row.id)).toEqual([...SAFETY_ORDER]);
  });

  // FAIL LOUD, NOT SILENT. If a future phase adds a level above HIGH_RISK and
  // forgets this list, the job should surface too early rather than sink out
  // of sight.
  it('sorts an unknown safety level as most urgent', () => {
    const unknown = job({ id: 'unknown', safetyLevel: 'CATASTROPHIC' });
    const high = job({ id: 'high', safetyLevel: 'HIGH_RISK' });
    expect(orderQueue([high, unknown], NOW).map((row) => row.id)).toEqual(['unknown', 'high']);
  });

  it('is a stable order for two jobs identical on every key', () => {
    const a = job({ id: 'aaa' });
    const b = job({ id: 'bbb' });
    expect(orderQueue([b, a], NOW).map((row) => row.id)).toEqual(['aaa', 'bbb']);
    expect(orderQueue([a, b], NOW).map((row) => row.id)).toEqual(['aaa', 'bbb']);
  });
});

describe('SLA risk', () => {
  it('is the fraction of the window consumed', () => {
    expect(slaRisk(job({ createdAt: new Date(NOW.getTime() - 30 * 60_000) }), NOW)).toBeCloseTo(0.5, 5);
  });

  // NOT CLAMPED, deliberately: "20% over" and "300% over" are different
  // operational facts to a dispatcher working a backlog.
  it('goes above 1 once the window has closed', () => {
    expect(slaRisk(job({ createdAt: new Date(NOW.getTime() - 180 * 60_000) }), NOW)).toBeCloseTo(3, 5);
  });

  it('is zero for a job with no SLA at all', () => {
    expect(slaRisk(job({ slaResponseMinutes: null }), NOW)).toBe(0);
  });

  it('measures age independently of any SLA', () => {
    expect(ageMinutes(job({ createdAt: new Date(NOW.getTime() - 42 * 60_000) }), NOW)).toBeCloseTo(42, 5);
  });
});

describe('capability scarcity thresholds', () => {
  it('calls nothing-at-all critical regardless of fleet size', () => {
    expect(classifyShare(0, 24)).toBe('red');
    expect(classifyShare(0, 1)).toBe('red');
  });

  it('is red below the red share and amber below the amber share', () => {
    expect(classifyShare(Math.floor(RED_SHARE * 100) - 1, 100)).toBe('red');
    expect(classifyShare(Math.floor(AMBER_SHARE * 100) - 1, 100)).toBe('amber');
    expect(classifyShare(50, 100)).toBe('ok');
  });

  // A single crew is a single point of failure whatever the ratio says: one
  // technician calling in sick takes the capability to zero.
  it('treats a lone crew as thin even in a tiny fleet', () => {
    expect(classifyShare(1, 1)).toBe('amber');
    expect(classifyShare(2, 2)).toBe('ok');
  });

  it('sorts the scarcest capability first, stably', () => {
    const rows = [
      summarise({ code: 'COMMON', crewedPairs: 20, unitsWithCapability: 24, techniciansWithCapability: 31, totalCrewedUnits: 24, totalTechnicians: 31 }),
      summarise({ code: 'EV_HV_CERTIFICATION', crewedPairs: 1, unitsWithCapability: 2, techniciansWithCapability: 2, totalCrewedUnits: 24, totalTechnicians: 31 }),
      summarise({ code: 'FLATBED_LOADING', crewedPairs: 5, unitsWithCapability: 6, techniciansWithCapability: 6, totalCrewedUnits: 24, totalTechnicians: 31 }),
    ];

    expect(rows.sort(byUrgency).map((row) => row.code)).toEqual([
      'EV_HV_CERTIFICATION',
      'FLATBED_LOADING',
      'COMMON',
    ]);
  });

  it('never reports more crews than either half of the pair', () => {
    const row = summarise({
      code: 'X',
      crewedPairs: 2,
      unitsWithCapability: 6,
      techniciansWithCapability: 3,
      totalCrewedUnits: 24,
      totalTechnicians: 31,
    });
    expect(row.crewedPairs).toBeLessThanOrEqual(row.unitsWithCapability);
    expect(row.crewedPairs).toBeLessThanOrEqual(row.techniciansWithCapability);
  });
});
