// SAFETY TRIAGE — how dangerous is it to be standing next to this vehicle
// right now, independent of what is wrong with it.
//
// This is separate from the fault distribution on purpose. A flat tyre is a
// trivial repair; a flat tyre in a live lane of a highway at night with a
// driver alone in the car is not, and the two facts have to be able to move
// independently. Invariant 4 says safety level orders dispatch options
// LEXICOGRAPHICALLY ABOVE the cost function — a HIGH_RISK job is never traded
// against a cheaper plan, it is simply served first. Nothing consumes this
// until Phase 9; it is computed and stored now so that when allocation arrives
// the data is already there for every historical job.
//
// The rules are a flat, readable list rather than nested conditionals, because
// the question an operator will ask is "why is this job HIGH_RISK" and the
// answer has to be a list of triggered reason codes, not a number.
//
// PURE. No clock, no I/O — `night` is passed in, never read from the system
// time, so a seeded replay in Phase 10 produces the same level every run.

import { z } from 'zod';
import type { RoadPosition, SafetyLevel } from '@prisma/client';
import { isOnHighway } from './location.js';

// WHAT A CALLER MAY STATE. Everything here is something only the person at the
// roadside can know, so the client is the right source for it.
//
// Two facts are deliberately ABSENT, because the client is the wrong source for
// both and letting it supply them is how they end up disagreeing with the rest
// of the job:
//   onHighway — derived from the reported road position (see location.ts)
//   night     — derived from the clock
// Neither is something a caller should be able to assert about itself, and
// while `onHighway` was accepted here it was possible to file a highway
// breakdown that triaged as NORMAL.
export const safetyReportSchema = z.object({
  // Speed of the traffic passing the vehicle, not the vehicle's own speed.
  // Null means nobody asked; it is not the same as zero.
  trafficSpeedKph: z.number().int().min(0).max(200).nullable().default(null),
  blockingLiveLane: z.boolean().default(false),
  smokeOrBurningSmell: z.boolean().default(false),
  fuelSmell: z.boolean().default(false),
  overheating: z.boolean().default(false),
  driverAlone: z.boolean().default(false),
  // Children, elderly or anyone who cannot leave the vehicle unaided.
  vulnerablePassengers: z.boolean().default(false),
  // Strict for the same reason as the location schema: a caller that tries to
  // set `onHighway` or `night` gets an error, not a silent strip.
}).strict();

export type SafetyReport = z.infer<typeof safetyReportSchema>;

// What triage actually reasons over: what the caller said, plus the two facts
// the server decides. `triageSafety` takes this and nothing else, so there is
// exactly one shape that can reach the rules.
export type SafetyContext = SafetyReport & {
  onHighway: boolean;
  // The driver never said where the vehicle is standing. Not the same as "not
  // on a highway" — it is the absence of the answer, and it is treated as a
  // risk in its own right. See UNKNOWN_POSITION below.
  positionUnknown: boolean;
  night: boolean;
};

// The only way to build a context. It takes the reported ROAD POSITION, not a
// pre-computed flag, and runs the same `isOnHighway` the job's location column
// is written from — one fact, one home, and no opportunity for a caller to hand
// in a value that disagrees with the row. `night` comes from the instant the
// job was filed, which the simulator supplies as simulated time so a seeded
// replay triages identically every run.
export function buildSafetyContext(
  report: SafetyReport,
  derived: { roadPosition: RoadPosition | null; at: Date },
): SafetyContext {
  return {
    ...report,
    onHighway: isOnHighway(derived.roadPosition),
    positionUnknown: derived.roadPosition === null,
    night: isNightAt(derived.at),
  };
}

// Above this, a stationary vehicle in traffic is a serious impact risk rather
// than an inconvenience. Chosen to match Indian expressway limits.
const FAST_TRAFFIC_KPH = 80;

type SafetyRule = {
  code: string;
  level: Exclude<SafetyLevel, 'NORMAL'>;
  applies: (context: SafetyContext) => boolean;
};

// Grouped by topic — where the vehicle is, then what the vehicle is doing,
// then who is in it — because an operator reads the reason codes in this order
// and "on a highway, blocking a live lane" is the sentence they expect.
//
// The ORDER CARRIES NO SEVERITY. The level is the highest that fires, never the
// first, and the list deliberately opens with an ELEVATED rule so that anything
// which quietly starts trusting position instead of severity gets caught by
// tests/intake.test.ts rather than by a HIGH_RISK job being triaged as routine.
const SAFETY_RULES: SafetyRule[] = [
  // FAIL CLOSED. Not knowing where the vehicle is standing is itself a risk,
  // and it is ranked as one rather than being quietly treated as "not on a
  // highway". Everything else in this system fails closed when a fact is
  // missing — `NO_TENANT` and `NO_OWNER` filter to nothing rather than to
  // everything — and safety is where failing open is least acceptable. The
  // trade is deliberately asymmetric: over-triaging costs a marginally slower
  // or more expensive dispatch, while under-triaging leaves a highway
  // breakdown ranked on cost alone, and only one of those can hurt somebody.
  {
    code: 'UNKNOWN_POSITION',
    level: 'ELEVATED',
    applies: (c) => c.positionUnknown,
  },
  {
    code: 'ON_HIGHWAY',
    level: 'ELEVATED',
    applies: (c) => c.onHighway,
  },
  // DELIBERATELY NOT COLLAPSED INTO `roadPosition === 'LANE'`. These look like
  // one fact and are two: road position is GEOMETRY — where the vehicle is
  // standing — and this is CONTEXT — whether that position is obstructing
  // moving traffic. A car stopped in a lane of an empty road at 3am is in a
  // lane and is blocking nobody. Merging them would make every LANE job
  // HIGH_RISK, which is a triage decision dressed up as a refactor. If a future
  // cleanup spots the resemblance: it is not the `onHighway` duplication, it
  // has been looked at, and the answer is no.
  {
    code: 'BLOCKING_LIVE_LANE',
    level: 'HIGH_RISK',
    applies: (c) => c.blockingLiveLane,
  },
  {
    code: 'STOPPED_IN_FAST_TRAFFIC',
    level: 'HIGH_RISK',
    applies: (c) => c.onHighway && c.trafficSpeedKph !== null && c.trafficSpeedKph >= FAST_TRAFFIC_KPH,
  },
  {
    code: 'OVERHEATING',
    level: 'ELEVATED',
    applies: (c) => c.overheating,
  },
  {
    code: 'FIRE_RISK',
    level: 'HIGH_RISK',
    applies: (c) => c.smokeOrBurningSmell,
  },
  {
    code: 'FUEL_LEAK',
    level: 'HIGH_RISK',
    applies: (c) => c.fuelSmell,
  },
  {
    code: 'VULNERABLE_PASSENGERS',
    level: 'ELEVATED',
    applies: (c) => c.vulnerablePassengers,
  },
  {
    code: 'NIGHT_AND_ALONE',
    level: 'ELEVATED',
    applies: (c) => c.night && c.driverAlone,
  },
  // Alone, in the dark, on a highway shoulder is the classic roadside
  // vulnerability case even when nothing about the vehicle is dangerous.
  {
    code: 'ALONE_AT_NIGHT_ON_HIGHWAY',
    level: 'HIGH_RISK',
    applies: (c) => c.onHighway && c.night && c.driverAlone,
  },
];

export type SafetyTriage = {
  level: SafetyLevel;
  reasonCodes: string[];
};

export function triageSafety(context: SafetyContext): SafetyTriage {
  const triggered = SAFETY_RULES.filter((rule) => rule.applies(context));
  const highRisk = triggered.some((rule) => rule.level === 'HIGH_RISK');

  let level: SafetyLevel = 'NORMAL';
  if (highRisk) {
    level = 'HIGH_RISK';
  } else if (triggered.length > 0) {
    level = 'ELEVATED';
  }

  return { level, reasonCodes: triggered.map((rule) => rule.code) };
}

// Bengaluru is UTC+5:30 and does not observe daylight saving, so a fixed offset
// is correct here rather than merely convenient. Night is taken as 21:00–06:00
// local: dark enough that a driver on a shoulder is hard to see.
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const NIGHT_STARTS_HOUR = 21;
const NIGHT_ENDS_HOUR = 6;

export function isNightAt(instant: Date): boolean {
  const localMinutes = instant.getUTCHours() * 60 + instant.getUTCMinutes() + IST_OFFSET_MINUTES;
  const localHour = Math.floor((localMinutes / 60) % 24);
  return localHour >= NIGHT_STARTS_HOUR || localHour < NIGHT_ENDS_HOUR;
}
