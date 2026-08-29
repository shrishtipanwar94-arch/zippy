// What the simulator is told to produce. Every field is a plain value so the
// Phase 10 evaluation harness can build a config in code and replay it, rather
// than shelling out to the CLI and parsing text.
//
// DETERMINISM IS THE CONTRACT. Same seed, same config, same run — otherwise
// there is no harness and no measured result to defend. That is why the seed is
// a required field with a default rather than something derived from the clock.

import { FAULT_CODES } from '../domain/faults.js';
import type { FaultCode } from '../domain/faults.js';

// Where the vehicle broke down. The simulator picks one of these, and the
// safety level is then whatever src/domain/safety.ts makes of it — the
// simulator never asserts a safety level directly, because triage is the
// single decision-maker and a second copy of those rules here would drift.
export const SITUATIONS = [
  'LOCAL_ROAD',
  'PARKING',
  'HIGHWAY_SHOULDER',
  'HIGHWAY_LANE',
] as const;

export type Situation = (typeof SITUATIONS)[number];

export type SimulatorConfig = {
  seed: number;
  arrivalsPerHour: number;
  durationMinutes: number;
  // Relative weights, not probabilities — they are normalised when sampled, so
  // a partial override on the command line still makes sense.
  faultMix: Record<FaultCode, number>;
  situationMix: Record<Situation, number>;
  // Stop after this many jobs even if the duration has not elapsed. Null for no
  // cap. The deployed board runs uncapped; a test run caps.
  maxJobs: number | null;
  // Real time per simulated minute. 0 means "as fast as the database allows",
  // which is what a one-shot replay wants. The long-lived worker uses a real
  // value so the board fills at a watchable pace.
  realSecondsPerSimulatedMinute: number;
  // The instant simulated time starts at. Fixed by default, because whether a
  // job is triaged as a night call is derived from the clock — if the clock
  // were the wall clock, the same seed would produce different safety levels
  // depending on when you ran it, and the run would not be reproducible. The
  // live worker passes null and uses the wall clock, because a board showing
  // jobs from last June is worse than useless.
  startAtIso: string | null;
};

// Roughly the shape of a real roadside mix: batteries and tyres dominate,
// specialists are rare. Scarcity is the point — an EV fault that only two
// technicians in the seed can handle is what makes dispatch interesting.
export const DEFAULT_FAULT_MIX: Record<FaultCode, number> = {
  FLAT_BATTERY: 22,
  FAILED_BATTERY: 10,
  ALTERNATOR_FAILURE: 5,
  STARTER_MOTOR: 5,
  OUT_OF_FUEL: 8,
  FLAT_TYRE: 20,
  KEYS_LOCKED_IN: 9,
  KEY_FAILURE: 3,
  ENGINE_OVERHEAT: 6,
  BRAKE_FAILURE: 3,
  EV_HV_FAULT: 4,
  IMMOBILISED_UNKNOWN: 5,
};

export const DEFAULT_SITUATION_MIX: Record<Situation, number> = {
  LOCAL_ROAD: 55,
  PARKING: 20,
  HIGHWAY_SHOULDER: 20,
  HIGHWAY_LANE: 5,
};

export const DEFAULT_CONFIG: SimulatorConfig = {
  seed: 1,
  arrivalsPerHour: 40,
  durationMinutes: 60,
  faultMix: DEFAULT_FAULT_MIX,
  situationMix: DEFAULT_SITUATION_MIX,
  maxJobs: null,
  realSecondsPerSimulatedMinute: 0,
  startAtIso: '2026-06-01T09:00:00.000Z',
};

// Parses "FLAT_TYRE=50,FLAT_BATTERY=10" into weights layered over a base mix.
// Unknown keys are rejected loudly: a typo that silently did nothing would make
// a whole evaluation run meaningless.
export function parseMix<K extends string>(
  text: string,
  base: Record<K, number>,
  allowed: readonly K[],
): Record<K, number> {
  const mix = { ...base };

  for (const pair of text.split(',')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;

    const [key, value] = trimmed.split('=');
    const weight = Number(value);
    if (!key || !allowed.includes(key as K) || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`invalid mix entry "${trimmed}"; expected one of ${allowed.join(', ')}=<weight>`);
    }
    mix[key as K] = weight;
  }

  return mix;
}

export function parseFaultMix(text: string): Record<FaultCode, number> {
  return parseMix(text, DEFAULT_FAULT_MIX, FAULT_CODES);
}

export function parseSituationMix(text: string): Record<Situation, number> {
  return parseMix(text, DEFAULT_SITUATION_MIX, SITUATIONS);
}
