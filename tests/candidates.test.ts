// src/engine/candidates.ts — the pure pair-enumeration and capability-coverage
// logic. Runs whether or not OSRM is up: every assertion here is about
// capability math and pair counting, none of it about the actual travel-time
// VALUE, so it does not need to control which of OSRM or the haversine
// fallback answered. src/infra/routing.ts's own tests cover that distinction.

import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/engine/candidates.js';
import { haversineTravelTimes } from '../src/infra/routing.js';
import type { DispatchSnapshot, JobForDispatch, UnitSnapshot, TechnicianSnapshot } from '../src/engine/candidates.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';

// A distribution over all twelve codes that sums to 1, with everything not
// explicitly given weight set to 0 — most tests only care about one or two
// faults and should not have to enumerate the rest.
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
    createdAt: new Date('2026-06-01T09:00:00Z'),
    slaResponseMinutes: null,
    parkingLevel: null,
    onHighway: false,
    safetyLevel: 'NORMAL',
    ...overrides,
  };
}

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id: 'unit-1',
    zoneId: 'zone-1',
    currentTechnicianId: null,
    capabilityCodes: [],
    lat: 12.94,
    lng: 77.63,
    kind: 'VAN',
    status: 'AVAILABLE',
    ...overrides,
  };
}

function technician(overrides: Partial<TechnicianSnapshot> = {}): TechnicianSnapshot {
  return { id: 'tech-1', capabilityCodes: [], ...overrides };
}

function snapshot(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
  return { units: [], technicians: [], shifts: [], zones: [], ...overrides };
}

// THE ANSWER TO "DOESN'T THAT BLOW UP THE MATRIX?" — the question Phase 19
// exists to be asked. Parts introduce a genuine choice per pair (van shelf, or
// a depot run, or neither), and the naive way to model a choice is a candidate
// per branch, which multiplies the assignment problem by the number of ways to
// get a part. src/engine/partSourcing.ts resolves that choice INSIDE
// generation and keeps only the winner, so the matrix the Hungarian algorithm
// sees is the same size it was before parts existed. That is the claim, and
// this is the test of it.
describe('option count', () => {
  const batteryJob = job({ faultDistribution: distribution({ FAILED_BATTERY: 1 }) });

  const crew = ['BATTERY_REPLACEMENT'];
  const fleet = snapshot({
    units: [
      unit({ id: 'stocked', currentTechnicianId: 't1', capabilityCodes: crew }),
      unit({ id: 'empty', currentTechnicianId: 't2', capabilityCodes: crew }),
      unit({ id: 'unverified', currentTechnicianId: 't3', capabilityCodes: crew }),
    ],
    technicians: [
      technician({ id: 't1', capabilityCodes: crew }),
      technician({ id: 't2', capabilityCodes: crew }),
      technician({ id: 't3', capabilityCodes: crew }),
    ],
    parts: {
      stock: [
        { unitId: 'stocked', sku: 'BAT-45AH', quantity: 2, confidence: 'VERIFIED' },
        { unitId: 'unverified', sku: 'BAT-45AH', quantity: 2, confidence: 'UNVERIFIED' },
      ],
      valuePaiseBySku: { 'BAT-45AH': 480_000 },
      depots: [{ id: 'depot-near', code: 'DEP-NEAR', lat: 12.94, lng: 77.63 }],
    },
  });

  it('still equals the pair count once parts are modelled', async () => {
    const withParts = await generateCandidates(batteryJob, fleet, haversineTravelTimes);
    const withoutParts = await generateCandidates(
      batteryJob,
      { ...fleet, parts: null },
      haversineTravelTimes,
    );

    expect(withParts).toHaveLength(3);
    expect(withParts.length).toBe(fleet.units.length);
    expect(withParts.length).toBe(withoutParts.length);
    expect(new Set(withParts.map((option) => option.unitId)).size).toBe(3);
  });

  it('makes each option richer instead: three pairs, three different sourcings', async () => {
    const options = await generateCandidates(batteryJob, fleet, haversineTravelTimes);
    const statusByUnit = new Map(
      options.map((option) => [option.unitId, option.partSourcing.status]),
    );

    expect(statusByUnit.get('stocked')).toBe('IN_VAN');
    expect(statusByUnit.get('empty')).toBe('WORKSHOP_RUN');
    // Fails closed: the count is too old to act on, so the van is treated as
    // empty and the crew is sent via the depot like anybody else.
    expect(statusByUnit.get('unverified')).toBe('WORKSHOP_RUN');
  });
});

describe('pair enumeration', () => {
  it('emits exactly one option per crewed (unit, technician) pair', async () => {
    const fleet = snapshot({
      units: [
        unit({ id: 'u1', currentTechnicianId: 't1' }),
        unit({ id: 'u2', currentTechnicianId: 't2' }),
        unit({ id: 'u3', currentTechnicianId: 't3' }),
      ],
      technicians: [technician({ id: 't1' }), technician({ id: 't2' }), technician({ id: 't3' })],
    });

    const options = await generateCandidates(job(), fleet);

    expect(options).toHaveLength(3);
    expect(new Set(options.map((option) => option.unitId)).size).toBe(3);
    expect(new Set(options.map((option) => option.technicianId)).size).toBe(3);
  });

  it('produces no option for a unit with no current technician', async () => {
    const fleet = snapshot({
      units: [unit({ id: 'crewed', currentTechnicianId: 't1' }), unit({ id: 'uncrewed', currentTechnicianId: null })],
      technicians: [technician({ id: 't1' })],
    });

    const options = await generateCandidates(job(), fleet);

    expect(options).toHaveLength(1);
    expect(options[0]!.unitId).toBe('crewed');
  });

  it('skips a unit whose crew id is not in the snapshot, rather than throwing', async () => {
    const fleet = snapshot({
      units: [unit({ id: 'u1', currentTechnicianId: 'nobody' })],
      technicians: [],
    });

    const options = await generateCandidates(job(), fleet);
    expect(options).toEqual([]);
  });

  it('returns an empty array for an empty fleet, calling no routing at all', async () => {
    const options = await generateCandidates(job(), snapshot());
    expect(options).toEqual([]);
  });
});

describe('capability coverage', () => {
  // Flat battery needs JUMP_START; failed battery needs BATTERY_REPLACEMENT.
  const mixedDistribution = distribution({ FLAT_BATTERY: 0.5, FAILED_BATTERY: 0.5 });

  it('a broad-capability technician covers more of the fault mass than a narrow one', async () => {
    const fleet = snapshot({
      units: [
        unit({ id: 'broad-unit', currentTechnicianId: 'broad-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
        unit({ id: 'narrow-unit', currentTechnicianId: 'narrow-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
      ],
      technicians: [
        technician({ id: 'broad-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
        technician({ id: 'narrow-tech', capabilityCodes: ['JUMP_START'] }),
      ],
    });

    const options = await generateCandidates(job({ faultDistribution: mixedDistribution }), fleet);
    const broad = options.find((option) => option.unitId === 'broad-unit')!;
    const narrow = options.find((option) => option.unitId === 'narrow-unit')!;

    expect(broad.coveredFaultProbability).toBeCloseTo(1, 10);
    expect(narrow.coveredFaultProbability).toBeCloseTo(0.5, 10);
    expect(broad.coveredFaultProbability).toBeGreaterThan(narrow.coveredFaultProbability);
  });

  // The brief's own phrasing: broad beats NEAREST, not just narrow — proximity
  // and capability are independent axes, and this is the test that would
  // catch coveredFaultProbability accidentally factoring in distance.
  it('a broad-capability technician far away still outscores a nearby narrow one', async () => {
    const fleet = snapshot({
      units: [
        unit({ id: 'nearby-narrow', currentTechnicianId: 'narrow-tech', lat: job().lat + 0.001, lng: job().lng + 0.001, capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
        unit({ id: 'far-broad', currentTechnicianId: 'broad-tech', lat: job().lat + 0.5, lng: job().lng + 0.5, capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
      ],
      technicians: [
        technician({ id: 'narrow-tech', capabilityCodes: ['JUMP_START'] }),
        technician({ id: 'broad-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
      ],
    });

    const options = await generateCandidates(job({ faultDistribution: mixedDistribution }), fleet);
    const nearby = options.find((option) => option.unitId === 'nearby-narrow')!;
    const far = options.find((option) => option.unitId === 'far-broad')!;

    expect(far.estimatedTravelMinutes).toBeGreaterThan(nearby.estimatedTravelMinutes);
    expect(far.coveredFaultProbability).toBeGreaterThan(nearby.coveredFaultProbability);
  });

  it('the intersection is what counts — a skill on only one side of the pair does not', async () => {
    // The technician can do EV work; the van has no EV equipment. Neither the
    // unit-only nor the technician-only skill should count.
    const fleet = snapshot({
      units: [unit({ id: 'u1', currentTechnicianId: 't1', capabilityCodes: ['JUMP_START'] })],
      technicians: [technician({ id: 't1', capabilityCodes: ['JUMP_START', 'EV_HV_CERTIFICATION'] })],
    });

    const options = await generateCandidates(
      job({ faultDistribution: distribution({ EV_HV_FAULT: 1 }) }),
      fleet,
    );

    expect(options[0]!.coveredFaultProbability).toBe(0);
  });

  it('lists exactly the missing capabilities, and none when the pair covers everything required', async () => {
    const fleet = snapshot({
      units: [
        unit({ id: 'full', currentTechnicianId: 'full-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
        unit({ id: 'partial', currentTechnicianId: 'partial-tech', capabilityCodes: ['JUMP_START'] }),
      ],
      technicians: [
        technician({ id: 'full-tech', capabilityCodes: ['JUMP_START', 'BATTERY_REPLACEMENT'] }),
        technician({ id: 'partial-tech', capabilityCodes: ['JUMP_START'] }),
      ],
    });

    const options = await generateCandidates(job({ faultDistribution: mixedDistribution }), fleet);
    const full = options.find((option) => option.unitId === 'full')!;
    const partial = options.find((option) => option.unitId === 'partial')!;

    expect(full.missingCapabilities).toEqual([]);
    expect(partial.missingCapabilities).toEqual(['BATTERY_REPLACEMENT']);
  });
});

describe('location fallback', () => {
  it('falls back to the zone centroid when a unit has no GPS position', async () => {
    const fleet = snapshot({
      units: [unit({ id: 'u1', currentTechnicianId: 't1', zoneId: 'zone-x', lat: null, lng: null })],
      technicians: [technician({ id: 't1' })],
      zones: [{ id: 'zone-x', centroidLat: 12.9, centroidLng: 77.6 }],
    });

    const options = await generateCandidates(job(), fleet);

    expect(options).toHaveLength(1);
    expect(options[0]!.estimatedTravelMinutes).toBeGreaterThan(0);
    expect(Number.isFinite(options[0]!.estimatedTravelMinutes)).toBe(true);
  });

  it('throws rather than guessing when a unit has neither a position nor a known zone', async () => {
    const fleet = snapshot({
      units: [unit({ id: 'u1', currentTechnicianId: 't1', zoneId: 'ghost-zone', lat: null, lng: null })],
      technicians: [technician({ id: 't1' })],
      zones: [],
    });

    await expect(generateCandidates(job(), fleet)).rejects.toThrow(/no location and no known zone/);
  });
});

describe('travel time', () => {
  it('every option reports a real, finite, non-negative travel time and a real degraded flag', async () => {
    const fleet = snapshot({
      units: [unit({ id: 'u1', currentTechnicianId: 't1' })],
      technicians: [technician({ id: 't1' })],
    });

    const [option] = await generateCandidates(job(), fleet);

    // Deliberately not asserting a specific method here — whether this
    // environment has OSRM up or is running on the fallback is exactly what
    // tests/routing.test.ts exists to pin down; this only asserts the shape
    // every caller can rely on regardless of which one answered.
    expect(option!.estimatedTravelMinutes).toBeGreaterThan(0);
    expect(Number.isFinite(option!.estimatedTravelMinutes)).toBe(true);
    expect(typeof option!.travelEstimateDegraded).toBe('boolean');
  });
});
