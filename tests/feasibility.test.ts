// src/engine/feasibility.ts — one passing test per reason code, plus the
// brief's own named scenario and the two structural guarantees invariant 3
// depends on: nothing is dropped silently, and a rejected option is never
// quietly adjusted into a feasible one with a penalty attached.

import { describe, expect, it } from 'vitest';
import { checkFeasibility } from '../src/engine/feasibility.js';
import type {
  DispatchOption,
  DispatchSnapshot,
  JobForDispatch,
  ShiftSnapshot,
  TechnicianSnapshot,
  UnitKindSnapshot,
  UnitSnapshot,
  UnitStatusSnapshot,
} from '../src/engine/candidates.js';
import {
  MAX_PART_SOURCING_DETOUR_MINUTES,
  NO_PARTS_MODELLED,
} from '../src/engine/partSourcing.js';
import type { PartSourcing } from '../src/engine/partSourcing.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';

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

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id: 'unit-1',
    zoneId: 'zone-1',
    currentTechnicianId: 'tech-1',
    capabilityCodes: ['JUMP_START'],
    lat: 12.94,
    lng: 77.63,
    kind: 'VAN',
    status: 'AVAILABLE',
    ...overrides,
  };
}

function technician(overrides: Partial<TechnicianSnapshot> = {}): TechnicianSnapshot {
  return { id: 'tech-1', capabilityCodes: ['JUMP_START'], ...overrides };
}

// On shift for the whole day, by default, so tests not about shifts do not
// have to think about it.
function shift(overrides: Partial<ShiftSnapshot> = {}): ShiftSnapshot {
  return {
    technicianId: 'tech-1',
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-06-01T23:59:00Z'),
    ...overrides,
  };
}

function snapshot(overrides: Partial<DispatchSnapshot> = {}): DispatchSnapshot {
  return {
    units: [unit()],
    technicians: [technician()],
    shifts: [shift()],
    zones: [],
    ...overrides,
  };
}

// A DispatchOption built by hand, not through generateCandidates — feasibility
// tests need exact control over travel time and missing capabilities without
// depending on OSRM being reachable at all.
function option(overrides: Partial<DispatchOption> = {}): DispatchOption {
  return {
    unitId: 'unit-1',
    technicianId: 'tech-1',
    estimatedTravelMinutes: 10,
    travelEstimateDegraded: false,
    estimatedTravelKm: 5,
    resolvableFaults: ['FLAT_BATTERY'],
    skillResolvableFaults: ['FLAT_BATTERY'],
    partSourcing: NO_PARTS_MODELLED,
    coveredFaultProbability: 1,
    missingCapabilities: [],
    ...overrides,
  };
}

describe('a fully feasible option', () => {
  it('is feasible, and none of it is rejected', () => {
    const result = checkFeasibility([option()], job(), snapshot(), NOW);
    expect(result.feasible).toEqual([option()]);
    expect(result.rejected).toEqual([]);
  });
});

describe('UNIT_UNAVAILABLE', () => {
  it.each(['ON_JOB', 'MAINTENANCE', 'OFFLINE', 'HELD'] as UnitStatusSnapshot[])(
    'rejects a unit that is %s',
    (status) => {
      const result = checkFeasibility(
        [option()],
        job(),
        snapshot({ units: [unit({ status })] }),
        NOW,
      );

      expect(result.feasible).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.code).toBe('UNIT_UNAVAILABLE');
      expect(result.rejected[0]!.detail).toContain(status.toLowerCase());
    },
  );
});

describe('VEHICLE_TYPE_INCOMPATIBLE', () => {
  it('rejects a bike sent to a job that needs a tow, even if it claims the capability', () => {
    // IMMOBILISED_UNKNOWN needs FLATBED_LOADING — nothing a BIKE ever carries
    // (prisma/seed/fleet.ts). missingCapabilities is deliberately left empty
    // so this fires on unit KIND alone, independent of capability bookkeeping
    // — the defence-in-depth this code exists for.
    const towJob = job({ faultDistribution: distribution({ IMMOBILISED_UNKNOWN: 1 }) });
    const bike = unit({ kind: 'BIKE', capabilityCodes: ['JUMP_START'] });

    const result = checkFeasibility(
      [option({ missingCapabilities: [] })],
      towJob,
      snapshot({ units: [bike] }),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('VEHICLE_TYPE_INCOMPATIBLE');
    expect(result.rejected[0]!.detail).toContain('BIKE');
  });

  // PINS THE ORDERING. This pair fails BOTH VEHICLE_TYPE_INCOMPATIBLE and
  // CAPABILITY_MISSING at once — a bike, genuinely missing the tow
  // capability too, sent to a job that needs one. The wrong-kind-of-vehicle
  // reason wins, because it is the more fundamental fact: no amount of
  // training or extra equipment lets a bike carry a car, whereas a missing
  // capability reads as fixable. Without this test, swapping the two checks'
  // order changes nothing else here — see the phase's own DECISIONS.log entry
  // for how that was found out the hard way.
  it('reports the vehicle-kind reason, not the capability reason, when a pair fails both', () => {
    const towJob = job({ faultDistribution: distribution({ IMMOBILISED_UNKNOWN: 1 }) });
    const bike = unit({ kind: 'BIKE', capabilityCodes: ['JUMP_START'] });

    const result = checkFeasibility(
      [option({ missingCapabilities: ['FLATBED_LOADING'] })],
      towJob,
      snapshot({ units: [bike] }),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('VEHICLE_TYPE_INCOMPATIBLE');
  });

  it('does not reject a flatbed for the same tow job', () => {
    const towJob = job({ faultDistribution: distribution({ IMMOBILISED_UNKNOWN: 1 }) });
    const flatbed = unit({ kind: 'FLATBED_TOW', capabilityCodes: ['FLATBED_LOADING', 'WINCH_RECOVERY'] });

    const result = checkFeasibility(
      [option({ missingCapabilities: [] })],
      towJob,
      snapshot({ units: [flatbed] }),
      NOW,
    );

    expect(result.rejected).toEqual([]);
  });
});

describe('CAPABILITY_MISSING', () => {
  // THE BRIEF'S OWN NAMED SCENARIO: an EV job with no certified technician
  // produces CAPABILITY_MISSING in rejected, not a high-cost feasible option
  // — there is no cost function in this phase to produce one, and that is
  // the point invariant 3 makes: the option is REMOVED, not merely ranked low.
  it('rejects an EV fault with no EV-certified technician on the pair', () => {
    const evJob = job({ faultDistribution: distribution({ EV_HV_FAULT: 1 }) });
    const uncertifiedOption = option({ missingCapabilities: ['EV_HV_CERTIFICATION'] });

    const result = checkFeasibility([uncertifiedOption], evJob, snapshot(), NOW);

    expect(result.feasible).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.code).toBe('CAPABILITY_MISSING');
    expect(result.rejected[0]!.detail).toContain('EV_HV_CERTIFICATION');
    // Not adjusted, not penalised, not stripped down — the exact option that
    // went in comes back out, attached to the reason it was removed.
    expect(result.rejected[0]!.option).toEqual(uncertifiedOption);
  });
});

describe('ACCESS_RESTRICTION', () => {
  it('rejects a flatbed sent to a basement parking level', () => {
    const basementJob = job({ parkingLevel: 'B2' });
    const flatbed = unit({ kind: 'FLATBED_TOW', capabilityCodes: ['FLATBED_LOADING', 'WINCH_RECOVERY', 'JUMP_START'] });

    const result = checkFeasibility(
      [option()],
      basementJob,
      snapshot({ units: [flatbed] }),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('ACCESS_RESTRICTION');
    expect(result.rejected[0]!.detail).toContain('B2');
  });

  it('does not reject a van from the same basement level', () => {
    const basementJob = job({ parkingLevel: 'B2' });
    const result = checkFeasibility([option()], basementJob, snapshot(), NOW);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a road time that implies the far side of a divided highway', () => {
    // Unit and job are ~1.5km apart in a straight line, but the option's own
    // travel time is set to 60 minutes — far beyond what 40km/h over 1.5km
    // would ever take, exactly the shape a genuine carriageway crossing
    // produces (Phase 6 measured 243x on real Bengaluru data).
    const highwayJob = job({ onHighway: true, lat: 12.94, lng: 77.63 });
    const nearbyUnit = unit({ lat: 12.9352, lng: 77.6245 });
    const strandedAcrossTheDivider = option({ estimatedTravelMinutes: 60 });

    const result = checkFeasibility(
      [strandedAcrossTheDivider],
      highwayJob,
      snapshot({ units: [nearbyUnit] }),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('ACCESS_RESTRICTION');
  });

  it('does not reject the same long travel time when the job is not on a highway', () => {
    const localJob = job({ onHighway: false, lat: 12.94, lng: 77.63 });
    const nearbyUnit = unit({ lat: 12.9352, lng: 77.6245 });

    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 60 })],
      localJob,
      snapshot({ units: [nearbyUnit] }),
      NOW,
    );

    expect(result.rejected).toEqual([]);
  });
});

describe('NO_TECHNICIAN_ON_SHIFT', () => {
  it('rejects a technician with no shift covering right now', () => {
    const endedShift = shift({
      startsAt: new Date('2026-05-31T00:00:00Z'),
      endsAt: new Date('2026-06-01T08:00:00Z'), // ended an hour before NOW
    });

    const result = checkFeasibility([option()], job(), snapshot({ shifts: [endedShift] }), NOW);

    expect(result.rejected[0]!.code).toBe('NO_TECHNICIAN_ON_SHIFT');
  });

  it('rejects a technician on shift now whose shift ends before the job could complete', () => {
    // On shift, but only 20 minutes left — not enough for 10 minutes' travel
    // plus the assumed 45-minute service time.
    const endingSoon = shift({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 20 * 60_000) });

    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 10 })],
      job(),
      snapshot({ shifts: [endingSoon] }),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('NO_TECHNICIAN_ON_SHIFT');
  });

  it('does not reject a technician with comfortably enough shift left', () => {
    const plentyOfTime = shift({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 4 * 60 * 60_000) });
    const result = checkFeasibility([option()], job(), snapshot({ shifts: [plentyOfTime] }), NOW);
    expect(result.rejected).toEqual([]);
  });
});

describe('SLA_UNREACHABLE', () => {
  it('rejects an option that would arrive after the SLA response window', () => {
    // Created 5 minutes ago with a 10-minute SLA — the deadline is 5 minutes
    // from now. A 20-minute travel time misses it comfortably.
    const urgentJob = job({
      createdAt: new Date(NOW.getTime() - 5 * 60_000),
      slaResponseMinutes: 10,
    });

    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 20 })],
      urgentJob,
      snapshot(),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('SLA_UNREACHABLE');
  });

  it('does not reject an option that arrives inside the window', () => {
    const urgentJob = job({ createdAt: NOW, slaResponseMinutes: 30 });
    const result = checkFeasibility([option({ estimatedTravelMinutes: 10 })], urgentJob, snapshot(), NOW);
    expect(result.rejected).toEqual([]);
  });

  // THE PHASE 13 CHANGE, and the measurement behind it. This filter used to
  // apply whatever the time was, and because the deadline is a function of the
  // clock, a job still queued when its window closed had EVERY option rejected
  // — permanently. Phase 10's harness found that accounted for most of the
  // unserved jobs in a busy scenario, and that it surfaced nowhere: the
  // rejection code reads exactly like the healthy case of one van being too
  // far away.
  //
  // Refusing to dispatch to a job you are already late for does not avoid a
  // breach, it converts a late arrival into no arrival. So once the window has
  // closed the filter stops applying and the job competes on cost like any
  // other.
  it('stops filtering once the window has already closed', () => {
    // Created an hour ago with a 10-minute SLA: the deadline is 50 minutes in
    // the past. Under the old rule this option — and every other — was
    // rejected forever.
    const lateJob = job({
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
      slaResponseMinutes: 10,
    });

    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 20 })],
      lateJob,
      snapshot(),
      NOW,
    );

    expect(result.rejected).toEqual([]);
    expect(result.feasible).toHaveLength(1);
  });

  // The filter still does its real job while the promise can still be kept:
  // prefer a crew who can actually make it.
  it('still rejects a miss while the window is open', () => {
    const urgentJob = job({
      createdAt: new Date(NOW.getTime() - 1 * 60_000),
      slaResponseMinutes: 30,
    });

    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 45 })],
      urgentJob,
      snapshot(),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('SLA_UNREACHABLE');
  });

  it('never fires for a job with no SLA policy at all', () => {
    const noSlaJob = job({ slaResponseMinutes: null });
    const result = checkFeasibility(
      [option({ estimatedTravelMinutes: 500 })],
      noSlaJob,
      snapshot(),
      NOW,
    );
    expect(result.rejected).toEqual([]);
  });
});

// STUBS — Phase 19, 20 and 22's codes. Each is real, wired plumbing that
// currently never fires, proved here by a scenario that would be a natural
// place for it to fire if it existed, staying feasible instead.
// PART_UNAVAILABLE — real from Phase 19. The sourcing decision was made in
// candidate generation; this filter only reads the verdict, so these tests set
// the verdict directly rather than building a fleet and a depot.
describe('PART_UNAVAILABLE', () => {
  function sourcing(overrides: Partial<PartSourcing> = {}): PartSourcing {
    return {
      status: 'UNAVAILABLE',
      detourMinutes: 0,
      partValuePaise: 0,
      depotId: null,
      missingSkus: ['BAT-45AH'],
      ...overrides,
    };
  }

  it('rejects a crew who has the skill and cannot get the part', () => {
    const result = checkFeasibility([option({ partSourcing: sourcing() })], job(), snapshot(), NOW);

    expect(result.feasible).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.code).toBe('PART_UNAVAILABLE');
    expect(result.rejected[0]!.detail).toContain('BAT-45AH');
    expect(result.rejected[0]!.detail).toContain(String(MAX_PART_SOURCING_DETOUR_MINUTES));
  });

  // The ordering matters more than the code. A crew missing the SKILL and the
  // part is a capability problem; saying PART_UNAVAILABLE would send a
  // dispatcher looking for a battery when what they need is a technician.
  it('yields to CAPABILITY_MISSING, so the code names the fundamental problem', () => {
    const result = checkFeasibility(
      [option({ partSourcing: sourcing(), missingCapabilities: ['BATTERY_REPLACEMENT'] })],
      job(),
      snapshot(),
      NOW,
    );

    expect(result.rejected[0]!.code).toBe('CAPABILITY_MISSING');
  });

  it('lets a workshop run through — a detour is a cost, not a constraint', () => {
    const result = checkFeasibility(
      [
        option({
          partSourcing: sourcing({
            status: 'WORKSHOP_RUN',
            detourMinutes: 8,
            partValuePaise: 480_000,
            depotId: 'depot-near',
          }),
        }),
      ],
      job(),
      snapshot(),
      NOW,
    );

    expect(result.rejected).toEqual([]);
    expect(result.feasible).toHaveLength(1);
  });

  // The detour is time the driver waits, so the SLA has to be measured against
  // when the crew really turns up rather than against the drive alone.
  it('counts the detour against the SLA deadline', () => {
    const detouring = option({
      estimatedTravelMinutes: 20,
      partSourcing: sourcing({ status: 'WORKSHOP_RUN', detourMinutes: 20, depotId: 'depot-near' }),
    });

    const direct = checkFeasibility([option({ estimatedTravelMinutes: 20 })], job({ slaResponseMinutes: 30 }), snapshot(), NOW);
    const viaDepot = checkFeasibility([detouring], job({ slaResponseMinutes: 30 }), snapshot(), NOW);

    expect(direct.feasible).toHaveLength(1);
    expect(viaDepot.rejected[0]!.code).toBe('SLA_UNREACHABLE');
  });
});

describe('stub codes — never fire yet, on purpose', () => {
  it('NO_DESTINATION_AVAILABLE does not exist until Phase 22', () => {
    const result = checkFeasibility([option()], job(), snapshot(), NOW);
    expect(result.rejected.find((rejection) => rejection.code === 'NO_DESTINATION_AVAILABLE')).toBeUndefined();
  });

  it('DESTINATION_NOT_AUTHORISED does not exist until Phase 22', () => {
    const result = checkFeasibility([option()], job(), snapshot(), NOW);
    expect(result.rejected.find((rejection) => rejection.code === 'DESTINATION_NOT_AUTHORISED')).toBeUndefined();
  });

  it('TENANT_CONTRACT_EXCLUDES does not exist until Phase 20', () => {
    const result = checkFeasibility([option()], job(), snapshot(), NOW);
    expect(result.rejected.find((rejection) => rejection.code === 'TENANT_CONTRACT_EXCLUDES')).toBeUndefined();
  });
});

describe('invariant 3 — filters, not penalties', () => {
  it('never drops an option silently: every input option is feasible or rejected, never neither', () => {
    const options = [
      option({ unitId: 'unit-1' }),
      option({ unitId: 'unit-2', technicianId: 'tech-2' }),
    ];
    const twoUnits = snapshot({
      units: [unit({ id: 'unit-1' }), unit({ id: 'unit-2', currentTechnicianId: 'tech-2', status: 'OFFLINE' })],
      technicians: [technician({ id: 'tech-1' }), technician({ id: 'tech-2' })],
      shifts: [shift({ technicianId: 'tech-1' }), shift({ technicianId: 'tech-2' })],
    });

    const result = checkFeasibility(options, job(), twoUnits, NOW);

    expect(result.feasible.length + result.rejected.length).toBe(options.length);
  });

  it('throws rather than silently accepting an option whose pair is not in the snapshot', () => {
    const orphanOption = option({ unitId: 'ghost-unit' });
    expect(() => checkFeasibility([orphanOption], job(), snapshot(), NOW)).toThrow();
  });
});
