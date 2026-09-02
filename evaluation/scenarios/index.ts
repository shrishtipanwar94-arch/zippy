// THE SIX SCENARIOS, fully determined by their seed.
//
// A scenario is data, not behaviour: a fleet, a list of jobs with arrival
// times, a hidden true fault per job, and any technician dropouts. The runner
// replays it against each policy, so every policy sees byte-identical input.
//
// THE HIDDEN TRUE FAULT is what makes the whole harness mean anything. Each
// job carries a probability distribution (what the dispatcher believes) AND a
// `trueFault` (what is actually wrong). The solver only ever sees the
// distribution. The runner uses the true fault to decide whether the crew who
// turned up could actually fix it — which is where a second dispatch comes
// from, and therefore where time-to-resolution diverges from time-to-arrival.

import { createRandom } from '../../src/sim/random.js';
import type { Random } from '../../src/sim/random.js';
import { FAULT_CODES } from '../../src/domain/faults.js';
import type { FaultCode, FaultDistribution } from '../../src/domain/faults.js';
import type { DispatchSnapshot, JobForDispatch } from '../../src/engine/candidates.js';
import { buildSnapshot, FULL_FLEET, zoneSnapshots } from './fleet.js';
import type { FleetShape } from './fleet.js';

// Every scenario starts at the same wall-clock instant so shift windows,
// arrival offsets and SLA deadlines are all reproducible. Mid-morning, when
// the seeded morning and day bands overlap.
export const SCENARIO_START = new Date('2026-06-01T05:00:00.000Z'); // 10:30 IST

export type ScenarioJob = {
  job: JobForDispatch;
  zoneId: string;
  arrivalMinute: number;
  trueFault: FaultCode;
};

export type Dropout = { technicianId: string; atMinute: number };

export type Scenario = {
  name: string;
  description: string;
  jobs: ScenarioJob[];
  snapshot: DispatchSnapshot;
  horizonMinutes: number;
  dropouts: Dropout[];
};

export type ScenarioOverrides = {
  jobCount?: number;
  fleet?: Partial<FleetShape>;
};

// ---------------------------------------------------------------------------
// Building one job.

function distributionOf(weights: Partial<Record<FaultCode, number>>): FaultDistribution {
  const total = Object.values(weights).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const distribution = {} as FaultDistribution;
  for (const fault of FAULT_CODES) distribution[fault] = (weights[fault] ?? 0) / total;
  return distribution;
}

// Draw the fault that is ACTUALLY wrong, in proportion to the belief. A job
// whose distribution says 70% flat battery is genuinely a flat battery 70% of
// the time — the belief is calibrated, which is the friendly case. Nothing
// here models a mis-calibrated diagnosis; that would be a different study.
function drawTrueFault(distribution: FaultDistribution, random: Random): FaultCode {
  let target = random.next();
  for (const fault of FAULT_CODES) {
    target -= distribution[fault];
    if (target <= 0) return fault;
  }
  return FAULT_CODES[0];
}

function makeJob(
  index: number,
  arrivalMinute: number,
  weights: Partial<Record<FaultCode, number>>,
  random: Random,
  slaResponseMinutes: number | null,
): ScenarioJob {
  const zones = zoneSnapshots();
  const zone = zones[random.nextInt(zones.length)]!;

  // Scattered within roughly 3km of a zone centroid, the same spread the seed
  // uses for its service areas.
  const lat = zone.centroidLat + (random.next() - 0.5) * 0.06;
  const lng = zone.centroidLng + (random.next() - 0.5) * 0.06;

  const distribution = distributionOf(weights);

  return {
    zoneId: zone.id,
    arrivalMinute,
    trueFault: drawTrueFault(distribution, random),
    job: {
      id: `eval-job-${String(index + 1).padStart(4, '0')}`,
      lat,
      lng,
      faultDistribution: distribution,
      createdAt: new Date(SCENARIO_START.getTime() + arrivalMinute * 60_000),
      slaResponseMinutes,
      // No contract terms in the harness. A scenario measures policies against
      // each other, and a breach penalty on some jobs and not others would be a
      // second thing varying between runs — see the SLA note in scenarios.ts.
      contract: null,
      parkingLevel: null,
      onHighway: false,
      vehicleMake: 'MARUTI_SUZUKI',
      vehicleEvClass: null,
      safetyLevel: 'NORMAL',
    },
  };
}

// The everyday mix: mostly simple faults, a thin tail of hard ones. Weights
// are the belief a real intake would arrive at, not the base rates.
const COMMON_MIXES: Partial<Record<FaultCode, number>>[] = [
  { FLAT_TYRE: 0.9, IMMOBILISED_UNKNOWN: 0.1 },
  { FLAT_BATTERY: 0.75, FAILED_BATTERY: 0.25 },
  { OUT_OF_FUEL: 0.95, IMMOBILISED_UNKNOWN: 0.05 },
  { KEYS_LOCKED_IN: 0.85, KEY_FAILURE: 0.15 },
  { FLAT_BATTERY: 0.5, ALTERNATOR_FAILURE: 0.3, FAILED_BATTERY: 0.2 },
  { STARTER_MOTOR: 0.6, FLAT_BATTERY: 0.4 },
  { ENGINE_OVERHEAT: 0.85, STARTER_MOTOR: 0.15 },
];

// Poisson arrivals: exponential gaps, because real queues form from bunching
// rather than even spacing. Same reasoning as src/sim/scenarios.ts.
function arrivalMinutes(count: number, overMinutes: number, random: Random): number[] {
  const meanGap = overMinutes / count;
  const minutes: number[] = [];
  let clock = 0;
  for (let i = 0; i < count; i++) {
    clock += -Math.log(1 - random.next()) * meanGap;
    minutes.push(Math.min(clock, overMinutes));
  }
  return minutes;
}

function fleetShape(overrides: ScenarioOverrides | undefined, base: FleetShape): FleetShape {
  return { ...base, ...(overrides?.fleet ?? {}) };
}

// ---------------------------------------------------------------------------
// The six scenarios.

function normalDay(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const count = overrides?.jobCount ?? 60;
  const shape = fleetShape(overrides, FULL_FLEET);

  const jobs = arrivalMinutes(count, 480, random).map((minute, index) =>
    makeJob(index, minute, COMMON_MIXES[random.nextInt(COMMON_MIXES.length)]!, random, 45),
  );

  return {
    name: 'normal-day',
    description: '60 jobs over 8 hours against the full fleet. The baseline.',
    jobs,
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts: [],
  };
}

function monsoonSurge(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const count = overrides?.jobCount ?? 180;
  const shape = fleetShape(overrides, FULL_FLEET);

  // Rain drives the mix as well as the volume: more immobilised vehicles and
  // electrical faults, fewer lockouts.
  const wetMixes: Partial<Record<FaultCode, number>>[] = [
    { IMMOBILISED_UNKNOWN: 0.85, ENGINE_OVERHEAT: 0.15 },
    { FLAT_BATTERY: 0.6, ALTERNATOR_FAILURE: 0.4 },
    { FLAT_TYRE: 0.85, IMMOBILISED_UNKNOWN: 0.15 },
    { ENGINE_OVERHEAT: 0.7, STARTER_MOTOR: 0.3 },
  ];

  const jobs = arrivalMinutes(count, 240, random).map((minute, index) =>
    makeJob(index, minute, wetMixes[random.nextInt(wetMixes.length)]!, random, 60),
  );

  return {
    name: 'monsoon-surge',
    description: '180 jobs in 4 hours against 24 units. Demand well past capacity.',
    jobs,
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts: [],
  };
}

function capabilityScarcity(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const shape = fleetShape(overrides, FULL_FLEET);

  // Three EV calls within a few minutes of each other, against a fleet that
  // holds exactly two EV certifications. One of the three cannot be served by
  // anyone, and the question is which two the policy picks — and what it does
  // with the ordinary jobs competing for the same units.
  const evJobs = [0, 3, 6].map((minute, index) =>
    makeJob(index, minute, { EV_HV_FAULT: 1 }, random, 45),
  );

  const filler = arrivalMinutes(overrides?.jobCount ?? 20, 180, random).map((minute, index) =>
    makeJob(3 + index, minute, COMMON_MIXES[random.nextInt(COMMON_MIXES.length)]!, random, 45),
  );

  return {
    name: 'capability-scarcity',
    description: '3 simultaneous EV calls against 2 certified technicians, plus 20 ordinary jobs.',
    jobs: [...evJobs, ...filler],
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts: [],
  };
}

function ambiguousDiagnosis(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const count = overrides?.jobCount ?? 60;
  const shape = fleetShape(overrides, FULL_FLEET);

  // Deliberately flat beliefs: nothing is more than 35% likely, and the
  // contending faults need DIFFERENT capabilities. This is the case the
  // expected-time objective exists for — a generalist who can cover the whole
  // spread beats a specialist who can only cover the mode.
  const ambiguous: Partial<Record<FaultCode, number>>[] = [
    { FLAT_BATTERY: 0.3, FAILED_BATTERY: 0.25, ALTERNATOR_FAILURE: 0.25, STARTER_MOTOR: 0.2 },
    { ENGINE_OVERHEAT: 0.3, BRAKE_FAILURE: 0.3, STARTER_MOTOR: 0.2, FLAT_BATTERY: 0.2 },
    { KEY_FAILURE: 0.35, KEYS_LOCKED_IN: 0.35, STARTER_MOTOR: 0.3 },
    { FAILED_BATTERY: 0.3, ALTERNATOR_FAILURE: 0.3, FLAT_BATTERY: 0.2, STARTER_MOTOR: 0.2 },
  ];

  const jobs = arrivalMinutes(count, 480, random).map((minute, index) =>
    makeJob(index, minute, ambiguous[random.nextInt(ambiguous.length)]!, random, 45),
  );

  return {
    name: 'ambiguous-diagnosis',
    description: '60 jobs whose contending faults need different skills. No belief above 35%.',
    jobs,
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts: [],
  };
}

function technicianDropout(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const count = overrides?.jobCount ?? 60;
  const shape = fleetShape(overrides, FULL_FLEET);

  const jobs = arrivalMinutes(count, 480, random).map((minute, index) =>
    makeJob(index, minute, COMMON_MIXES[random.nextInt(COMMON_MIXES.length)]!, random, 45),
  );

  // Eight technicians go offline through the run, including tech-01 and
  // tech-02 — the only two EV certifications. A policy that spent them early
  // on jobs someone else could have taken has nothing left.
  const dropouts: Dropout[] = [
    { technicianId: 'tech-01', atMinute: 120 },
    { technicianId: 'tech-02', atMinute: 150 },
    { technicianId: 'tech-05', atMinute: 90 },
    { technicianId: 'tech-08', atMinute: 180 },
    { technicianId: 'tech-11', atMinute: 200 },
    { technicianId: 'tech-14', atMinute: 240 },
    { technicianId: 'tech-17', atMinute: 260 },
    { technicianId: 'tech-20', atMinute: 300 },
  ];

  return {
    name: 'technician-dropout',
    description: '60 jobs while 8 technicians go offline mid-run, including both EV certifications.',
    jobs,
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts,
  };
}

// EVERY JOB HERE CONSUMES A PART, against a fleet that has run half its
// shelves down. That combination is what makes the parts layer measurable: on
// an ordinary day most callouts are jump starts, lockouts and tows, which
// consume nothing at all (src/domain/faults.ts) and leave stock-awareness with
// nothing to be right about.
//
// The scarce thing is no longer a certification, it is a box in the back of a
// van, and the three greedy baselines cannot see it — they dispatch on skill
// and distance and then discover the shelf. `capability-aware-global` reads
// the same shelves the runner will open, treats an unverified count as absent,
// and prices a depot run when one is worth taking. `stockoutInducedFailures`
// is where the difference lands.
function partsStockout(seed: number, overrides?: ScenarioOverrides): Scenario {
  const random = createRandom(seed);
  const count = overrides?.jobCount ?? 60;
  const shape = fleetShape(overrides, { ...FULL_FLEET, stockDepletion: 0.5 });

  // Beliefs whose contending faults all need parts: a battery, a belt, a
  // starter, coolant, a key blank, brake pads. Nothing here can be finished
  // with tools alone.
  const partsHungry: Partial<Record<FaultCode, number>>[] = [
    { FAILED_BATTERY: 0.8, FLAT_BATTERY: 0.2 },
    { ALTERNATOR_FAILURE: 0.7, FAILED_BATTERY: 0.3 },
    { ENGINE_OVERHEAT: 0.85, STARTER_MOTOR: 0.15 },
    { BRAKE_FAILURE: 0.9, ENGINE_OVERHEAT: 0.1 },
    { KEY_FAILURE: 0.8, KEYS_LOCKED_IN: 0.2 },
    { STARTER_MOTOR: 0.75, FLAT_BATTERY: 0.25 },
  ];

  const jobs = arrivalMinutes(count, 480, random).map((minute, index) =>
    makeJob(index, minute, partsHungry[random.nextInt(partsHungry.length)]!, random, 45),
  );

  return {
    name: 'parts-stockout',
    description: '60 parts-consuming jobs against a fleet with half its shelves empty.',
    jobs,
    snapshot: buildSnapshot(shape, SCENARIO_START),
    horizonMinutes: 900,
    dropouts: [],
  };
}

const BUILDERS = {
  'normal-day': normalDay,
  'monsoon-surge': monsoonSurge,
  'capability-scarcity': capabilityScarcity,
  'ambiguous-diagnosis': ambiguousDiagnosis,
  'technician-dropout': technicianDropout,
  'parts-stockout': partsStockout,
} as const;

export type ScenarioName = keyof typeof BUILDERS;
export const SCENARIO_NAMES = Object.keys(BUILDERS) as ScenarioName[];

export function buildScenario(
  name: ScenarioName,
  seed: number,
  overrides?: ScenarioOverrides,
): Scenario {
  return BUILDERS[name](seed, overrides);
}
