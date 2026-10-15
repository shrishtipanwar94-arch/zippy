// src/engine/solve.ts — the four engine pieces assembled, and the two
// properties Phase 9 actually had to prove:
//
//   1. GLOBAL BEATS NEAREST. A greedy pass that gives each job its own best
//      option strands jobs that only one unit can serve. The Hungarian
//      assignment gives up a marginal first choice to keep the other job
//      servable, and the test constructs a scenario where those two answers
//      genuinely differ.
//   2. THE SOLVER WRITES NOTHING (invariant 2), asserted against a real
//      database by counting rows before and after — not by inspecting
//      imports, which would only prove the file does not KNOW about Prisma,
//      and not that it stayed silent.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { solve, hashSnapshot } from '../src/engine/solve.js';
import type { SolverOutcome } from '../src/engine/solve.js';
import type { SolveStage } from '../src/engine/trace.js';
import type { DispatchSnapshot, JobForDispatch } from '../src/engine/candidates.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';
import { prismaBase } from '../src/infra/prismaBase.js';

const NOW = new Date('2026-06-01T09:00:00Z');
const HUGE_THRESHOLD = 1_000_000; // never partition, unless a test asks for it

function distribution(weights: Partial<FaultDistribution>): FaultDistribution {
  const full = {} as FaultDistribution;
  for (const fault of FAULT_CODES) full[fault] = weights[fault] ?? 0;
  return full;
}

function job(id: string, overrides: Partial<JobForDispatch> = {}): JobForDispatch {
  return {
    id,
    lat: 28.6152,
    lng: 77.2095,
    faultDistribution: distribution({ FLAT_BATTERY: 1 }),
    createdAt: NOW,
    slaResponseMinutes: null,
    contract: null,
    parkingLevel: null,
    onHighway: false,
    vehicleMake: 'MARUTI_SUZUKI',
    vehicleEvClass: null,
    safetyLevel: 'NORMAL',
    ...overrides,
  };
}

const allDayShift = { startsAt: new Date('2026-06-01T00:00:00Z'), endsAt: new Date('2026-06-01T23:59:00Z') };

describe('solve — one plan per weight vector, over a real assignment', () => {
  it('returns one plan per weight vector', async () => {
    const outcome = await solve({
      jobs: [job('j1')],
      snapshot: {
        units: [
          {
            id: 'u1',
            zoneId: 'z1',
            currentTechnicianId: 't1',
            capabilityCodes: ['JUMP_START'],
            lat: 28.62,
            lng: 77.215,
            kind: 'VAN',
            status: 'AVAILABLE',
          },
        ],
        technicians: [{ id: 't1', capabilityCodes: ['JUMP_START'] }],
        shifts: [{ technicianId: 't1', ...allDayShift }],
        zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
      },
      now: NOW,
      jobZone: new Map([['j1', 'z1']]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(outcome.plans.map((plan) => plan.label).sort()).toEqual([
      'BALANCED',
      'FASTEST_RESOLUTION',
      'LOWEST_COST',
      'PROTECT_CONTRACTS',
    ]);
    expect(outcome.plans.every((plan) => plan.assignments.length === 1)).toBe(true);
  });

  // THE CHECK BLOCK'S OWN ASSERTION: global fulfils a job that nearest
  // strands. Two jobs, two units. The EV job can ONLY be served by the
  // EV-certified unit. The battery job could use either — and is closer to
  // the EV unit, so a nearest-first pass takes it and leaves the EV job with
  // nothing.
  it('global assignment fulfils a job that a nearest-first pass would strand', async () => {
    const evJob = job('ev-job', {
      faultDistribution: distribution({ EV_HV_FAULT: 1 }),
      lat: 28.67,
      lng: 77.275,
    });
    const batteryJob = job('battery-job', {
      faultDistribution: distribution({ FLAT_BATTERY: 1 }),
      lat: 28.6152,
      lng: 77.2095,
    });

    const snapshot: DispatchSnapshot = {
      units: [
        // The only EV-capable unit, and it happens to sit right next to the
        // battery job.
        {
          id: 'ev-unit',
          zoneId: 'z1',
          currentTechnicianId: 'ev-tech',
          capabilityCodes: ['JUMP_START', 'EV_HV_CERTIFICATION'],
          lat: 28.6153,
          lng: 77.2096,
          kind: 'VAN',
          status: 'AVAILABLE',
        },
        // A plain unit, further from the battery job.
        {
          id: 'basic-unit',
          zoneId: 'z1',
          currentTechnicianId: 'basic-tech',
          capabilityCodes: ['JUMP_START'],
          lat: 28.64,
          lng: 77.235,
          kind: 'VAN',
          status: 'AVAILABLE',
        },
      ],
      technicians: [
        { id: 'ev-tech', capabilityCodes: ['JUMP_START', 'EV_HV_CERTIFICATION'] },
        { id: 'basic-tech', capabilityCodes: ['JUMP_START'] },
      ],
      shifts: [
        { technicianId: 'ev-tech', ...allDayShift },
        { technicianId: 'basic-tech', ...allDayShift },
      ],
      zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
    };

    const outcome = await solve({
      jobs: [batteryJob, evJob],
      snapshot,
      now: NOW,
      jobZone: new Map([
        ['battery-job', 'z1'],
        ['ev-job', 'z1'],
      ]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    for (const plan of outcome.plans) {
      // Both jobs served — the whole point.
      expect(plan.unassignedJobIds, plan.label).toEqual([]);

      const evAssignment = plan.assignments.find((a) => a.jobId === 'ev-job');
      const batteryAssignment = plan.assignments.find((a) => a.jobId === 'battery-job');

      // The EV unit went to the EV job even though it was nearer the other
      // one, and the battery job took the further unit it can still use.
      expect(evAssignment?.unitId, plan.label).toBe('ev-unit');
      expect(batteryAssignment?.unitId, plan.label).toBe('basic-unit');
    }
  });

  it('reports jobs it cannot serve rather than dropping them', async () => {
    const snapshot: DispatchSnapshot = {
      units: [
        {
          id: 'only-unit',
          zoneId: 'z1',
          currentTechnicianId: 't1',
          capabilityCodes: ['JUMP_START'],
          lat: 28.62,
          lng: 77.215,
          kind: 'VAN',
          status: 'AVAILABLE',
        },
      ],
      technicians: [{ id: 't1', capabilityCodes: ['JUMP_START'] }],
      shifts: [{ technicianId: 't1', ...allDayShift }],
      zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
    };

    const outcome = await solve({
      jobs: [job('j1'), job('j2'), job('j3')],
      snapshot,
      now: NOW,
      jobZone: new Map([
        ['j1', 'z1'],
        ['j2', 'z1'],
        ['j3', 'z1'],
      ]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    for (const plan of outcome.plans) {
      expect(plan.assignments).toHaveLength(1);
      expect(plan.unassignedJobIds).toHaveLength(2);
      // Every job is accounted for — assigned or explicitly unassigned.
      const seen = [...plan.assignments.map((a) => a.jobId), ...plan.unassignedJobIds];
      expect(new Set(seen).size).toBe(3);
    }
  });

  it('never gives one unit to two jobs in the same plan', async () => {
    const snapshot: DispatchSnapshot = {
      units: [
        {
          id: 'u1',
          zoneId: 'z1',
          currentTechnicianId: 't1',
          capabilityCodes: ['JUMP_START'],
          lat: 28.62,
          lng: 77.215,
          kind: 'VAN',
          status: 'AVAILABLE',
        },
        {
          id: 'u2',
          zoneId: 'z1',
          currentTechnicianId: 't2',
          capabilityCodes: ['JUMP_START'],
          lat: 28.63,
          lng: 77.225,
          kind: 'VAN',
          status: 'AVAILABLE',
        },
      ],
      technicians: [
        { id: 't1', capabilityCodes: ['JUMP_START'] },
        { id: 't2', capabilityCodes: ['JUMP_START'] },
      ],
      shifts: [
        { technicianId: 't1', ...allDayShift },
        { technicianId: 't2', ...allDayShift },
      ],
      zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
    };

    const outcome = await solve({
      jobs: [job('j1'), job('j2')],
      snapshot,
      now: NOW,
      jobZone: new Map([
        ['j1', 'z1'],
        ['j2', 'z1'],
      ]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    for (const plan of outcome.plans) {
      const units = plan.assignments.map((a) => a.unitId);
      expect(new Set(units).size, plan.label).toBe(units.length);
    }
  });

  it('carries rejections through with their reason codes', async () => {
    const snapshot: DispatchSnapshot = {
      units: [
        {
          id: 'offline-unit',
          zoneId: 'z1',
          currentTechnicianId: 't1',
          capabilityCodes: ['JUMP_START'],
          lat: 28.62,
          lng: 77.215,
          kind: 'VAN',
          status: 'OFFLINE',
        },
      ],
      technicians: [{ id: 't1', capabilityCodes: ['JUMP_START'] }],
      shifts: [{ technicianId: 't1', ...allDayShift }],
      zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
    };

    const outcome = await solve({
      jobs: [job('j1')],
      snapshot,
      now: NOW,
      jobZone: new Map([['j1', 'z1']]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.code).toBe('UNIT_UNAVAILABLE');
    expect(outcome.rejected[0]!.jobId).toBe('j1');
    expect(outcome.feasibleCount).toBe(0);
    expect(outcome.plans.every((plan) => plan.unassignedJobIds.length === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ZONE PARTITIONING — the deliberate approximation, and its price.
//
// Above `zonePartitionThreshold` candidate options the solver stops solving
// one citywide matrix and solves each zone separately. That is a real trade,
// not a free optimisation, and both halves of it are pinned here: the
// threshold actually fires, and a job near a boundary genuinely does lose a
// better cross-zone option when it does. Phase 10's harness measures how
// often that costs anything in practice; these tests only prove the cost is
// real, so nobody later assumes partitioning is free.
describe('solve — zone partitioning', () => {
  // Two zones side by side. The job sits in zone A but is physically much
  // closer to zone B's unit — the boundary case, constructed deliberately.
  const boundaryJob = job('boundary-job', { lat: 28.6152, lng: 77.2095 });

  const twoZoneSnapshot: DispatchSnapshot = {
    units: [
      // Zone A's own unit, a long way from the job.
      {
        id: 'far-unit-zone-a',
        zoneId: 'zone-a',
        currentTechnicianId: 'tech-a',
        capabilityCodes: ['JUMP_START'],
        lat: 28.67,
        lng: 77.275,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
      // Zone B's unit, effectively next door to the job.
      {
        id: 'near-unit-zone-b',
        zoneId: 'zone-b',
        currentTechnicianId: 'tech-b',
        capabilityCodes: ['JUMP_START'],
        lat: 28.6153,
        lng: 77.2096,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
    ],
    technicians: [
      { id: 'tech-a', capabilityCodes: ['JUMP_START'] },
      { id: 'tech-b', capabilityCodes: ['JUMP_START'] },
    ],
    shifts: [
      { technicianId: 'tech-a', ...allDayShift },
      { technicianId: 'tech-b', ...allDayShift },
    ],
    zones: [
      { id: 'zone-a', centroidLat: 28.62, centroidLng: 77.215 },
      { id: 'zone-b', centroidLat: 28.61, centroidLng: 77.205 },
    ],
  };

  const jobZone = new Map([['boundary-job', 'zone-a']]);

  it('solves one matrix and takes the nearer cross-zone unit below the threshold', async () => {
    const outcome = await solve({
      jobs: [boundaryJob],
      snapshot: twoZoneSnapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(outcome.zonePartitioned).toBe(false);
    for (const plan of outcome.plans) {
      expect(plan.assignments[0]?.unitId, plan.label).toBe('near-unit-zone-b');
    }
  });

  // THE KNOWN APPROXIMATION, ASSERTED RATHER THAN ONLY COMMENTED. With
  // partitioning on, zone B's unit is solved in a different matrix and never
  // appears as a column for this job, so the job takes its own zone's far
  // unit instead. That is the cost of the approximation, in one test.
  it('loses the better cross-zone option once it partitions', async () => {
    const outcome = await solve({
      jobs: [boundaryJob],
      snapshot: twoZoneSnapshot,
      now: NOW,
      jobZone,
      // The threshold is a plain number here rather than config, so one
      // option is enough to trip it.
      zonePartitionThreshold: 1,
    });

    expect(outcome.zonePartitioned).toBe(true);
    for (const plan of outcome.plans) {
      expect(plan.assignments[0]?.unitId, plan.label).toBe('far-unit-zone-a');
    }
  });

  it('costs more than the unpartitioned answer — the approximation is not free', async () => {
    const whole = await solve({
      jobs: [boundaryJob],
      snapshot: twoZoneSnapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
    });
    const partitioned = await solve({
      jobs: [boundaryJob],
      snapshot: twoZoneSnapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: 1,
    });

    const balancedTotal = (outcome: SolverOutcome): number =>
      outcome.plans.find((plan) => plan.label === 'BALANCED')!.totalCost;

    expect(balancedTotal(partitioned)).toBeGreaterThan(balancedTotal(whole));
  });

  it('still never gives one unit to two jobs across partitions', async () => {
    // A second job in zone B, so both partitions have work. Each unit lives
    // in exactly one partition, which is what makes concatenating the plans
    // safe — this asserts that rather than trusting it.
    const zoneBJob = job('zone-b-job', { lat: 28.6154, lng: 77.2097 });

    const outcome = await solve({
      jobs: [boundaryJob, zoneBJob],
      snapshot: twoZoneSnapshot,
      now: NOW,
      jobZone: new Map([
        ['boundary-job', 'zone-a'],
        ['zone-b-job', 'zone-b'],
      ]),
      zonePartitionThreshold: 1,
    });

    expect(outcome.zonePartitioned).toBe(true);
    for (const plan of outcome.plans) {
      const units = plan.assignments.map((assignment) => assignment.unitId);
      expect(new Set(units).size, plan.label).toBe(units.length);
      // Every job is accounted for in every plan, partitioned or not.
      const seen = [...plan.assignments.map((a) => a.jobId), ...plan.unassignedJobIds];
      expect(new Set(seen).size, plan.label).toBe(2);
    }
  });

  it('reports a job unassigned when its own zone has no units at all', async () => {
    // Both units in zone B, the job in zone A. Two units rather than one so
    // the option count still clears the threshold and partitioning actually
    // fires — with a single option it would not, and the test would be
    // asserting the unpartitioned path by accident.
    const outcome = await solve({
      jobs: [boundaryJob],
      snapshot: {
        ...twoZoneSnapshot,
        units: twoZoneSnapshot.units.map((unit) => ({ ...unit, zoneId: 'zone-b' })),
      },
      now: NOW,
      jobZone,
      zonePartitionThreshold: 1,
    });

    expect(outcome.zonePartitioned).toBe(true);
    for (const plan of outcome.plans) {
      expect(plan.assignments, plan.label).toHaveLength(0);
      expect(plan.unassignedJobIds, plan.label).toEqual(['boundary-job']);
    }
  });
});

describe('snapshot hashing', () => {
  const snapshot: DispatchSnapshot = {
    units: [
      {
        id: 'u1',
        zoneId: 'z1',
        currentTechnicianId: 't1',
        capabilityCodes: ['JUMP_START', 'TYRE_CHANGE'],
        lat: 28.62,
        lng: 77.215,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
    ],
    technicians: [{ id: 't1', capabilityCodes: ['JUMP_START'] }],
    shifts: [{ technicianId: 't1', ...allDayShift }],
    zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
  };

  it('is stable for the same world', () => {
    expect(hashSnapshot([job('j1')], snapshot)).toBe(hashSnapshot([job('j1')], snapshot));
  });

  // Row order out of Postgres is not guaranteed. If the hash depended on it,
  // two identical worlds would look different and a stored SolverRun would
  // stop being replayable.
  it('ignores the order rows happened to come back in', () => {
    const reordered: DispatchSnapshot = {
      ...snapshot,
      units: [
        {
          ...snapshot.units[0]!,
          capabilityCodes: ['TYRE_CHANGE', 'JUMP_START'],
        },
      ],
    };
    expect(hashSnapshot([job('j1')], reordered)).toBe(hashSnapshot([job('j1')], snapshot));
  });

  it('changes when something that could change a decision changes', () => {
    const offline: DispatchSnapshot = {
      ...snapshot,
      units: [{ ...snapshot.units[0]!, status: 'OFFLINE' }],
    };
    expect(hashSnapshot([job('j1')], offline)).not.toBe(hashSnapshot([job('j1')], snapshot));
  });

  // A zone centroid looks like a label but is a real decision input: a unit
  // with no last-known position is located at it (candidates.ts
  // `unitLocation`). Two runs that produced different plans must not be able
  // to carry the same hash.
  it('changes when a zone centroid moves', () => {
    const moved: DispatchSnapshot = {
      ...snapshot,
      zones: [{ id: 'z1', centroidLat: 29.08, centroidLng: 77.685 }],
    };
    expect(hashSnapshot([job('j1')], moved)).not.toBe(hashSnapshot([job('j1')], snapshot));
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 2, ASSERTED AGAINST A REAL DATABASE.
//
// SCOPED TO THIS TEST'S OWN IDENTIFIERS, not to whole-table counts. The first
// version counted every row in eight tables before and after — which proved
// the point but only while nothing else was writing. `zippy_test` is shared
// and vitest runs files in parallel, so the moment another suite wrote a
// decision record mid-assertion this went red for a reason that had nothing to
// do with the solver. A test that fails when unrelated code is merely BUSY is
// not testing what it claims.
//
// The scoped version is also the stronger claim. The ids below (`inv2-*`) do
// not exist in the database at all, so if `solve()` wrote ANYTHING about the
// snapshot it was handed, a row referencing one of them would appear. Zero
// before and zero after is proof about this solve specifically, and no amount
// of concurrent activity elsewhere can fake it either way.
describe('the solver writes nothing', () => {
  const JOB_IDS = ['inv2-job-a', 'inv2-job-b'];
  const UNIT_ID = 'inv2-unit';
  const TECHNICIAN_ID = 'inv2-tech';

  // Every row any part of the dispatch path would create if the engine ever
  // reached for a database, counted by the identifiers this test invents.
  async function countTraces(): Promise<Record<string, number>> {
    const [jobs, units, technicians, runs, options, variants, events, holds] = await Promise.all([
      prismaBase.job.count({ where: { id: { in: JOB_IDS } } }),
      prismaBase.unit.count({ where: { id: UNIT_ID } }),
      prismaBase.technician.count({ where: { id: TECHNICIAN_ID } }),
      prismaBase.solverRun.count({ where: { jobId: { in: JOB_IDS } } }),
      prismaBase.dispatchOption.count({ where: { jobId: { in: JOB_IDS } } }),
      prismaBase.planVariant.count({ where: { jobId: { in: JOB_IDS } } }),
      prismaBase.jobEvent.count({ where: { jobId: { in: JOB_IDS } } }),
      prismaBase.unitHold.count({ where: { unitId: UNIT_ID } }),
    ]);
    return { jobs, units, technicians, runs, options, variants, events, holds };
  }

  beforeAll(async () => {
    await prismaBase.$connect();
  });

  afterAll(async () => {
    await prismaBase.$disconnect();
  });

  it('leaves no trace of the snapshot it was handed', async () => {
    const before = await countTraces();
    // Nothing in this test's world exists yet, which is what makes the
    // after-count meaningful rather than merely equal.
    expect(Object.values(before).every((count) => count === 0)).toBe(true);

    await solve({
      jobs: [job(JOB_IDS[0]!), job(JOB_IDS[1]!)],
      snapshot: {
        units: [
          {
            id: UNIT_ID,
            zoneId: 'z1',
            currentTechnicianId: TECHNICIAN_ID,
            capabilityCodes: ['JUMP_START'],
            lat: 28.62,
            lng: 77.215,
            kind: 'VAN',
            status: 'AVAILABLE',
          },
        ],
        technicians: [{ id: TECHNICIAN_ID, capabilityCodes: ['JUMP_START'] }],
        shifts: [{ technicianId: TECHNICIAN_ID, ...allDayShift }],
        zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
      },
      now: NOW,
      jobZone: new Map([
        [JOB_IDS[0]!, 'z1'],
        [JOB_IDS[1]!, 'z1'],
      ]),
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(await countTraces()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// PHASE 17 — THE PLANNER'S DEADLINE.
//
// A plan produced under a deadline is a different artifact from a plan
// produced to completion: it is the best one FOUND, not the best one there is.
// Two things have to be true or the degradation ladder is lying — the run has
// to STOP, and it has to SAY it stopped, naming the jobs nobody looked at.

describe('solve — the deadline (Phase 17)', () => {
  const snapshot = {
    units: [
      {
        id: 'u1',
        zoneId: 'z1',
        currentTechnicianId: 't1',
        capabilityCodes: ['JUMP_START'],
        lat: 28.62,
        lng: 77.215,
        kind: 'VAN' as const,
        status: 'AVAILABLE' as const,
      },
    ],
    technicians: [{ id: 't1', capabilityCodes: ['JUMP_START'] }],
    shifts: [{ technicianId: 't1', ...allDayShift }],
    zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
  };

  const jobZone = new Map([
    ['j1', 'z1'],
    ['j2', 'z1'],
    ['j3', 'z1'],
  ]);

  it('plans nothing and says so when the deadline has already passed', async () => {
    const outcome = await solve({
      jobs: [job('j1'), job('j2'), job('j3')],
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
      // Zero: every job is past the deadline before the loop starts.
      deadlineMs: 0,
    });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.unplannedJobIds).toEqual(['j1', 'j2', 'j3']);
    // Nothing was even generated, which is the point — the deadline is checked
    // BEFORE the expensive part, not after.
    expect(outcome.optionCount).toBe(0);
    expect(outcome.plans.every((plan) => plan.assignments.length === 0)).toBe(true);
  });

  it('says it ran to completion when it did', async () => {
    const outcome = await solve({
      jobs: [job('j1')],
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
      deadlineMs: 60_000,
    });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.unplannedJobIds).toEqual([]);
    expect(outcome.plans[0]?.assignments).toHaveLength(1);
  });

  it('leaves the flag off entirely when no deadline was given', async () => {
    // Every caller before Phase 17, and the evaluation harness still: a
    // measurement whose result depended on how busy the machine was would not
    // be a measurement.
    const outcome = await solve({
      jobs: [job('j1')],
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(outcome.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SOLVE TRACE (src/engine/trace.ts). The console streams these while a run
// is happening, so what matters is that they arrive in the order the work
// actually happened, that the numbers on them are the same numbers the finished
// outcome carries, and — the part invariant 2 cares about — that attaching a
// reporter cannot change the answer.

describe('solve — the stage trace', () => {
  const snapshot: DispatchSnapshot = {
    units: [
      {
        id: 'u1',
        zoneId: 'z1',
        currentTechnicianId: 't1',
        capabilityCodes: ['JUMP_START'],
        lat: 28.62,
        lng: 77.215,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
      {
        id: 'u2',
        zoneId: 'z1',
        currentTechnicianId: 't2',
        capabilityCodes: ['JUMP_START'],
        lat: 28.63,
        lng: 77.225,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
    ],
    technicians: [
      { id: 't1', capabilityCodes: ['JUMP_START'] },
      { id: 't2', capabilityCodes: ['JUMP_START'] },
    ],
    shifts: [
      { technicianId: 't1', ...allDayShift },
      { technicianId: 't2', ...allDayShift },
    ],
    zones: [{ id: 'z1', centroidLat: 28.62, centroidLng: 77.215 }],
  };

  const jobs = [job('risky', { safetyLevel: 'HIGH_RISK' }), job('ordinary')];
  const jobZone = new Map([
    ['risky', 'z1'],
    ['ordinary', 'z1'],
  ]);

  async function trace(): Promise<{ stages: SolveStage[]; outcome: SolverOutcome }> {
    const stages: SolveStage[] = [];
    const outcome = await solve({
      jobs,
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
      onStage: (stage) => stages.push(stage),
    });
    return { stages, outcome };
  }

  it('reports the run in the order the work happened', async () => {
    const { stages } = await trace();
    expect(stages.map((stage) => stage.stage)).toEqual([
      'PENDING',
      'CANDIDATES',
      'FEASIBILITY',
      'SAFETY_BANDS',
      'COST',
      'OUTCOME',
      'DONE',
    ]);
  });

  it('says the same numbers the finished outcome says', async () => {
    const { stages, outcome } = await trace();
    const candidates = stages.find((stage) => stage.stage === 'CANDIDATES')!;
    const feasibility = stages.find((stage) => stage.stage === 'FEASIBILITY')!;
    const done = stages.find((stage) => stage.stage === 'DONE')!;

    expect(candidates).toMatchObject({ optionCount: outcome.optionCount });
    expect(feasibility).toMatchObject({
      optionCount: outcome.optionCount,
      feasibleCount: outcome.feasibleCount,
      rejectedCount: outcome.rejected.length,
    });
    expect(done).toMatchObject({ wallClockMs: outcome.wallClockMs, timedOut: outcome.timedOut });
  });

  // The safety bands are the whole reason the trace exists, and this is the
  // claim: the dangerous round is solved against the full fleet and hands down
  // only what it did not take.
  it('reports the safety bands most dangerous first, each seeing fewer units', async () => {
    const { stages } = await trace();
    const bands = stages.find((stage) => stage.stage === 'SAFETY_BANDS')!;
    if (bands.stage !== 'SAFETY_BANDS') throw new Error('unreachable');

    expect(bands.planLabel).toBe('BALANCED');
    expect(bands.bands.map((band) => band.level)).toEqual(['HIGH_RISK', 'NORMAL']);
    expect(bands.bands[0]).toMatchObject({ jobCount: 1, assignedCount: 1, unitsOffered: 2, unitsLeftBelow: 1 });
    expect(bands.bands[1]).toMatchObject({ jobCount: 1, unitsOffered: 1 });
  });

  // Once per run, not once per weight vector: every vector solves the same
  // bands over the same jobs, and four copies of the same argument is not four
  // arguments.
  it('reports the bands for the recommended plan only', async () => {
    const { stages } = await trace();
    expect(stages.filter((stage) => stage.stage === 'SAFETY_BANDS')).toHaveLength(1);
  });

  // INVARIANT 2, THE NARROW VERSION. A reporter is a reader, never a writer:
  // the same snapshot with and without one has to produce the same plans, or
  // the evaluation harness (which passes none) would be measuring a different
  // system from the one the console shows.
  it('changes nothing about the plans it produces', async () => {
    const withReporter = await trace();
    const withoutReporter = await solve({
      jobs,
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: HUGE_THRESHOLD,
    });

    expect(withReporter.outcome.snapshotHash).toBe(withoutReporter.snapshotHash);
    expect(JSON.stringify(withReporter.outcome.plans)).toBe(JSON.stringify(withoutReporter.plans));
  });
});
