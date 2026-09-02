// src/engine/partSourcing.ts — where a part comes from, and what happens when
// it cannot come from anywhere.
//
// Travel time is pinned to `haversineTravelTimes` in every test here, unlike
// tests/candidates.test.ts: a detour is a difference between three road
// distances, so these assertions are about actual minutes and cannot be left
// to depend on whether an OSRM container happens to be running.

import { describe, expect, it } from 'vitest';
import { generateCandidates } from '../src/engine/candidates.js';
import type {
  DispatchSnapshot,
  JobForDispatch,
  TechnicianSnapshot,
  UnitSnapshot,
} from '../src/engine/candidates.js';
import {
  believableSkus,
  faultIsSourced,
  MAX_PART_SOURCING_DETOUR_MINUTES,
  NO_PARTS_MODELLED,
} from '../src/engine/partSourcing.js';
import type { PartsSnapshot, PartStockSnapshot } from '../src/engine/partSourcing.js';
import { haversineTravelTimes } from '../src/infra/routing.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';

function distribution(weights: Partial<FaultDistribution>): FaultDistribution {
  const full = {} as FaultDistribution;
  for (const fault of FAULT_CODES) full[fault] = weights[fault] ?? 0;
  return full;
}

// A failed battery: one capability (BATTERY_REPLACEMENT), one part (BAT-45AH).
// The simplest fault in the catalogue that needs both, which is what makes it
// the right one to reason about parts with.
const BATTERY_JOB: JobForDispatch = {
  id: 'job-1',
  lat: 12.9352,
  lng: 77.6245,
  faultDistribution: distribution({ FAILED_BATTERY: 1 }),
  createdAt: new Date('2026-06-01T09:00:00Z'),
  slaResponseMinutes: null,
  contract: null,
  parkingLevel: null,
  onHighway: false,
  vehicleMake: 'MARUTI_SUZUKI',
  vehicleEvClass: null,
  safetyLevel: 'NORMAL',
};

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id: 'unit-1',
    zoneId: 'zone-1',
    currentTechnicianId: 'tech-1',
    capabilityCodes: ['BATTERY_REPLACEMENT'],
    lat: 12.94,
    lng: 77.63,
    kind: 'VAN',
    status: 'AVAILABLE',
    ...overrides,
  };
}

function technician(overrides: Partial<TechnicianSnapshot> = {}): TechnicianSnapshot {
  return { id: 'tech-1', capabilityCodes: ['BATTERY_REPLACEMENT'], ...overrides };
}

function stock(overrides: Partial<PartStockSnapshot> = {}): PartStockSnapshot {
  return { unitId: 'unit-1', sku: 'BAT-45AH', quantity: 1, confidence: 'VERIFIED', ...overrides };
}

// Right next to the van, so a diversion through it costs almost nothing.
const NEAR_DEPOT = { id: 'depot-near', code: 'DEP-NEAR', lat: 12.94, lng: 77.63 };
// Roughly 45km away in a straight line, which at the fallback's 30km/h and 1.4
// road factor is well past MAX_PART_SOURCING_DETOUR_MINUTES in each direction.
const FAR_DEPOT = { id: 'depot-far', code: 'DEP-FAR', lat: 13.35, lng: 78.0 };

function parts(overrides: Partial<PartsSnapshot> = {}): PartsSnapshot {
  return {
    stock: [stock()],
    valuePaiseBySku: { 'BAT-45AH': 480_000 },
    depots: [NEAR_DEPOT],
    ...overrides,
  };
}

function snapshot(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
  return {
    units: [unit()],
    technicians: [technician()],
    shifts: [],
    zones: [],
    parts: parts(),
    ...overrides,
  };
}

function generate(fleet: DispatchSnapshot, job: JobForDispatch = BATTERY_JOB) {
  return generateCandidates(job, fleet, haversineTravelTimes);
}

describe('stock on the van', () => {
  it('sources the part in the van, at no cost and no detour', async () => {
    const [option] = await generate(snapshot());

    expect(option!.partSourcing.status).toBe('IN_VAN');
    expect(option!.partSourcing.detourMinutes).toBe(0);
    expect(option!.partSourcing.partValuePaise).toBe(0);
    expect(option!.resolvableFaults).toEqual(['FAILED_BATTERY']);
  });

  it('FAILS CLOSED on an unverified count — a shelf nobody has looked at is empty', async () => {
    const [option] = await generate(
      snapshot({ parts: parts({ stock: [stock({ confidence: 'UNVERIFIED' })] }) }),
    );

    expect(option!.partSourcing.status).toBe('WORKSHOP_RUN');
    expect(option!.partSourcing.missingSkus).toEqual(['BAT-45AH']);
  });

  it('an ageing count still counts — stale is not the same as absent', async () => {
    const [option] = await generate(
      snapshot({ parts: parts({ stock: [stock({ confidence: 'AGEING' })] }) }),
    );

    expect(option!.partSourcing.status).toBe('IN_VAN');
  });

  it('a shelf at zero is empty however recently it was counted', async () => {
    const [option] = await generate(
      snapshot({ parts: parts({ stock: [stock({ quantity: 0, confidence: 'VERIFIED' })] }) }),
    );

    expect(option!.partSourcing.status).toBe('WORKSHOP_RUN');
  });
});

describe('a workshop run', () => {
  it('prices the detour and the part, and still resolves the fault', async () => {
    const [option] = await generate(snapshot({ parts: parts({ stock: [] }) }));

    expect(option!.partSourcing.status).toBe('WORKSHOP_RUN');
    expect(option!.partSourcing.depotId).toBe('depot-near');
    expect(option!.partSourcing.partValuePaise).toBe(480_000);
    // The depot is on top of the van, so the diversion adds almost nothing.
    expect(option!.partSourcing.detourMinutes).toBeLessThan(5);
    // A crew who will be holding the part when they arrive CAN finish the job.
    expect(option!.resolvableFaults).toEqual(['FAILED_BATTERY']);
    expect(option!.skillResolvableFaults).toEqual(['FAILED_BATTERY']);
  });

  it('is refused when the detour is longer than a second dispatch would be', async () => {
    const [option] = await generate(
      snapshot({ parts: parts({ stock: [], depots: [FAR_DEPOT] }) }),
    );

    expect(option!.partSourcing.status).toBe('UNAVAILABLE');
    expect(option!.partSourcing.detourMinutes).toBe(0);
    // The fault drops out of what this pair can resolve, which is what turns
    // the stockout into capability shortfall risk in the cost function rather
    // than into a silently optimistic estimate.
    expect(option!.resolvableFaults).toEqual([]);
    expect(option!.skillResolvableFaults).toEqual(['FAILED_BATTERY']);
  });

  it('is refused when there is no depot at all', async () => {
    const [option] = await generate(snapshot({ parts: parts({ stock: [], depots: [] }) }));

    expect(option!.partSourcing.status).toBe('UNAVAILABLE');
    expect(option!.partSourcing.missingSkus).toEqual(['BAT-45AH']);
  });
});

describe('a snapshot with no parts model', () => {
  it('reasons about skills alone and rejects nothing for parts', async () => {
    const [option] = await generate(snapshot({ parts: null }));

    expect(option!.partSourcing).toEqual(NO_PARTS_MODELLED);
    // Not "the van is empty" — the question was never asked.
    expect(option!.resolvableFaults).toEqual(['FAILED_BATTERY']);
  });
});

describe('believableSkus', () => {
  it('keeps verified and ageing lines with stock, and drops everything else', () => {
    const skus = believableSkus(
      [
        stock({ sku: 'VERIFIED-SKU', confidence: 'VERIFIED' }),
        stock({ sku: 'AGEING-SKU', confidence: 'AGEING' }),
        stock({ sku: 'UNVERIFIED-SKU', confidence: 'UNVERIFIED' }),
        stock({ sku: 'EMPTY-SKU', quantity: 0 }),
        stock({ sku: 'OTHER-VAN-SKU', unitId: 'unit-2' }),
      ],
      'unit-1',
    );

    expect([...skus].sort()).toEqual(['AGEING-SKU', 'VERIFIED-SKU']);
  });
});

describe('faultIsSourced', () => {
  it('is true for a fault that consumes nothing, whatever the van holds', () => {
    expect(faultIsSourced('FLAT_BATTERY', new Set(), NO_PARTS_MODELLED)).toBe(true);
  });

  it('does not let a depot run cover a part it was never sent for', () => {
    const sourcing = {
      status: 'WORKSHOP_RUN' as const,
      detourMinutes: 5,
      partValuePaise: 1,
      depotId: 'depot-near',
      missingSkus: ['COOLANT-5L'],
    };

    expect(faultIsSourced('ENGINE_OVERHEAT', new Set(), sourcing)).toBe(true);
    expect(faultIsSourced('FAILED_BATTERY', new Set(), sourcing)).toBe(false);
  });
});

describe('the detour threshold', () => {
  it('is a filter rather than a very large number', () => {
    // Stated as a test because the temptation the invariant guards against is
    // to make an impossible sourcing "merely expensive" and let the ranking
    // sort it out. It cannot be outvoted if it is a constant, and this is the
    // constant.
    expect(MAX_PART_SOURCING_DETOUR_MINUTES).toBeGreaterThan(0);
  });
});
