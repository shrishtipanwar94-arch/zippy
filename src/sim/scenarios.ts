// Inventing a breakdown: when it happens, what is actually wrong, where, and
// what the driver is able to tell us about it.
//
// POISSON ARRIVALS
// Breakdowns do not arrive on a timetable — they arrive independently, at some
// average rate. The standard model for that is a Poisson process, and the gap
// between consecutive arrivals in one is exponentially distributed. Sampling an
// exponential from a uniform u is -ln(u)/rate. The practical difference from
// evenly spaced arrivals is bunching: real queues form because four calls land
// in the same minute, and a simulator that spaced them evenly would never
// produce the contention the dispatcher exists to handle.
//
// The TRUE FAULT is chosen first and kept hidden. Intake never sees it — it
// only sees symptoms generated from it. That is what makes "did the diagnosis
// land on the right fault" a question with an answer.
//
// Pure: everything here takes an explicit Random and returns plain objects. No
// database, no clock.

import type { FaultCode } from '../domain/faults.js';
import { symptomLikelihood } from '../domain/faultRules.js';
import { PRIMARY_COMPLAINTS, WARNING_LIGHTS, UNUSUAL_SOUNDS } from '../domain/symptoms.js';
import type { SymptomPayload } from '../domain/symptoms.js';
import type { SafetyReport } from '../domain/safety.js';
import type { LocationInput } from '../domain/location.js';
import type { Random } from './random.js';
import type { SimulatorConfig, Situation } from './config.js';

// How likely a driver is to volunteer each extra detail before being asked.
// Below 1 on purpose: a driver who volunteered everything would leave intake
// nothing to ask and the question count would collapse to zero for every job.
const VOLUNTEERS_ENGINE_CRANKS = 0.45;
const VOLUNTEERS_WARNING_LIGHT = 0.35;
const VOLUNTEERS_SOUND = 0.3;
const VOLUNTEERS_MOBILITY = 0.4;

// The complaint a driver leads with, given what is actually wrong. Not a
// likelihood table — this is the generative side, and drivers describe the same
// fault differently.
const COMPLAINT_MIX: Record<FaultCode, Partial<Record<SymptomPayload['primaryComplaint'], number>>> = {
  FLAT_BATTERY: { WONT_START: 80, WARNING_LIGHT: 8, UNKNOWN: 12 },
  FAILED_BATTERY: { WONT_START: 80, WARNING_LIGHT: 8, UNKNOWN: 12 },
  ALTERNATOR_FAILURE: { WARNING_LIGHT: 45, WONT_START: 35, NOISE_OR_SMELL: 10, UNKNOWN: 10 },
  STARTER_MOTOR: { WONT_START: 70, NOISE_OR_SMELL: 18, UNKNOWN: 12 },
  OUT_OF_FUEL: { WONT_START: 70, UNKNOWN: 30 },
  FLAT_TYRE: { FLAT_TYRE: 88, STUCK_OR_DAMAGED: 6, UNKNOWN: 6 },
  KEYS_LOCKED_IN: { LOCKED_OUT: 92, UNKNOWN: 8 },
  KEY_FAILURE: { WONT_START: 55, LOCKED_OUT: 25, UNKNOWN: 20 },
  ENGINE_OVERHEAT: { NOISE_OR_SMELL: 45, WARNING_LIGHT: 40, UNKNOWN: 15 },
  BRAKE_FAILURE: { WARNING_LIGHT: 45, NOISE_OR_SMELL: 35, UNKNOWN: 20 },
  EV_HV_FAULT: { WARNING_LIGHT: 50, WONT_START: 30, UNKNOWN: 20 },
  IMMOBILISED_UNKNOWN: { STUCK_OR_DAMAGED: 60, UNKNOWN: 30, NOISE_OR_SMELL: 10 },
};

// Weights over a fixed value list, drawn from the same table the classifier
// inverts. `symptomLikelihood` is P(value | fault), which is exactly the
// generative direction a simulated driver needs.
function sampleObservation<T extends string>(
  random: Random,
  field: Parameters<typeof symptomLikelihood>[0],
  values: readonly T[],
  trueFault: FaultCode,
): T {
  const weights = {} as Record<T, number>;
  for (const value of values) {
    weights[value] = symptomLikelihood(field, value, trueFault);
  }
  return random.pickWeighted(weights);
}

function sampleComplaint(random: Random, trueFault: FaultCode): SymptomPayload['primaryComplaint'] {
  const mix = {} as Record<SymptomPayload['primaryComplaint'], number>;
  for (const complaint of PRIMARY_COMPLAINTS) {
    mix[complaint] = COMPLAINT_MIX[trueFault][complaint] ?? 0;
  }
  return random.pickWeighted(mix);
}

export function generateSymptoms(random: Random, trueFault: FaultCode): SymptomPayload {
  const engineCranks = random.chance(VOLUNTEERS_ENGINE_CRANKS)
    ? sampleObservation(random, 'engineCranks', ['YES', 'NO', 'UNSURE'] as const, trueFault)
    : null;

  const warningLights = random.chance(VOLUNTEERS_WARNING_LIGHT)
    ? [sampleObservation(random, 'warningLight', WARNING_LIGHTS, trueFault)]
    : [];

  const unusualSound = random.chance(VOLUNTEERS_SOUND)
    ? sampleObservation(random, 'unusualSound', UNUSUAL_SOUNDS, trueFault)
    : null;

  const vehicleMoves = random.chance(VOLUNTEERS_MOBILITY)
    ? sampleObservation(random, 'vehicleMoves', ['true', 'false'] as const, trueFault) === 'true'
    : null;

  return {
    primaryComplaint: sampleComplaint(random, trueFault),
    engineCranks,
    warningLights: [...warningLights],
    unusualSound,
    vehicleMoves,
  };
}

// What a simulated driver would say about their situation. NOT the safety
// level, which triageSafety decides, and no longer `onHighway` or `night`
// either — both are derived server-side, from the road position and the clock.
// The simulator used to set `onHighway` here AND in generateLocation, both from
// the same `situation`, which is exactly why it never exposed the bug where a
// client set one and not the other.
export function generateSafetyReport(
  random: Random,
  situation: Situation,
  trueFault: FaultCode,
): SafetyReport {
  const onHighway = situation === 'HIGHWAY_SHOULDER' || situation === 'HIGHWAY_LANE';

  return {
    trafficSpeedKph: onHighway ? 60 + random.nextInt(41) : 20 + random.nextInt(30),
    blockingLiveLane: situation === 'HIGHWAY_LANE',
    smokeOrBurningSmell: trueFault === 'ENGINE_OVERHEAT' && random.chance(0.35),
    fuelSmell: random.chance(0.03),
    overheating: trueFault === 'ENGINE_OVERHEAT',
    driverAlone: random.chance(0.55),
    vulnerablePassengers: random.chance(0.12),
  };
}

const ROAD_POSITION_BY_SITUATION: Record<Situation, LocationInput['roadPosition']> = {
  LOCAL_ROAD: 'SERVICE_ROAD',
  PARKING: 'PARKING',
  HIGHWAY_SHOULDER: 'SHOULDER',
  HIGHWAY_LANE: 'LANE',
};

export function generateLocation(
  random: Random,
  situation: Situation,
  origin: { lat: number; lng: number },
): LocationInput {
  // Only for choosing plausible highway-shaped detail — exit numbers and km
  // markers. Whether the job counts as a highway job is derived from
  // roadPosition, downstream, and is not restated here.
  const onHighway = situation === 'HIGHWAY_SHOULDER' || situation === 'HIGHWAY_LANE';
  // Roughly +/- 3km around the zone centroid; 0.01 degrees is about 1.1km.
  const jitter = () => (random.next() - 0.5) * 0.06;

  return {
    lat: origin.lat + jitter(),
    lng: origin.lng + jitter(),
    headingDegrees: random.nextInt(360),
    accuracyMetres: null,
    nearestExit: onHighway ? `Exit ${8 + random.nextInt(30)}` : null,
    kmMarker: onHighway ? `KM ${12 + random.nextInt(80)}` : null,
    landmark: onHighway ? null : `Near landmark ${1 + random.nextInt(40)}`,
    roadPosition: ROAD_POSITION_BY_SITUATION[situation],
    parkingLevel: situation === 'PARKING' ? `B${1 + random.nextInt(3)}` : null,
  };
}

// Gaps between arrivals, in simulated seconds, for the whole run. Generated up
// front so the schedule is fixed by the seed and does not depend on how long
// the database takes to answer.
export function arrivalOffsetsSeconds(random: Random, config: SimulatorConfig): number[] {
  const totalSeconds = config.durationMinutes * 60;
  const ratePerSecond = config.arrivalsPerHour / 3600;
  const offsets: number[] = [];

  let clock = 0;
  for (;;) {
    // Guard against u = 0, which would give an infinite gap.
    const uniform = Math.max(random.next(), 1e-12);
    clock += -Math.log(uniform) / ratePerSecond;
    if (clock > totalSeconds) break;
    if (config.maxJobs !== null && offsets.length >= config.maxJobs) break;
    offsets.push(clock);
  }

  return offsets;
}
