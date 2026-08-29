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
import type { SafetyLevel } from '@prisma/client';

export const safetyContextSchema = z.object({
  onHighway: z.boolean().default(false),
  // Speed of the traffic passing the vehicle, not the vehicle's own speed.
  // Null means nobody asked; it is not the same as zero.
  trafficSpeedKph: z.number().int().min(0).max(200).nullable().default(null),
  blockingLiveLane: z.boolean().default(false),
  smokeOrBurningSmell: z.boolean().default(false),
  fuelSmell: z.boolean().default(false),
  overheating: z.boolean().default(false),
  night: z.boolean().default(false),
  driverAlone: z.boolean().default(false),
  // Children, elderly or anyone who cannot leave the vehicle unaided.
  vulnerablePassengers: z.boolean().default(false),
});

export type SafetyContext = z.infer<typeof safetyContextSchema>;

// Above this, a stationary vehicle in traffic is a serious impact risk rather
// than an inconvenience. Chosen to match Indian expressway limits.
const FAST_TRAFFIC_KPH = 80;

type SafetyRule = {
  code: string;
  level: Exclude<SafetyLevel, 'NORMAL'>;
  applies: (context: SafetyContext) => boolean;
};

// Order is presentation order only — the resulting level is the highest that
// fires, never the first.
const SAFETY_RULES: SafetyRule[] = [
  {
    code: 'BLOCKING_LIVE_LANE',
    level: 'HIGH_RISK',
    applies: (c) => c.blockingLiveLane,
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
    code: 'STOPPED_IN_FAST_TRAFFIC',
    level: 'HIGH_RISK',
    applies: (c) => c.onHighway && c.trafficSpeedKph !== null && c.trafficSpeedKph >= FAST_TRAFFIC_KPH,
  },
  // Alone, in the dark, on a highway shoulder is the classic roadside
  // vulnerability case even when nothing about the vehicle is dangerous.
  {
    code: 'ALONE_AT_NIGHT_ON_HIGHWAY',
    level: 'HIGH_RISK',
    applies: (c) => c.onHighway && c.night && c.driverAlone,
  },
  {
    code: 'ON_HIGHWAY',
    level: 'ELEVATED',
    applies: (c) => c.onHighway,
  },
  {
    code: 'OVERHEATING',
    level: 'ELEVATED',
    applies: (c) => c.overheating,
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
