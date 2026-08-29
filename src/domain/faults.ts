// The fault catalogue: what can actually be wrong with a broken-down vehicle,
// and which technician capability resolves each one.
//
// This is the vocabulary the whole intake pipeline speaks. The rule table
// (faultRules.ts) produces a probability distribution over these codes; the
// question selector (questionSelection.ts) narrows that distribution; dispatch
// (Phase 6+) consumes only the capability set at the end. Nothing downstream
// needs to know a fault code at all — it needs to know what skill to send.
//
// Capability codes must match the seeded catalogue in prisma/seed/capabilities.ts.

export const FAULT_CODES = [
  'FLAT_BATTERY',
  'FAILED_BATTERY',
  'ALTERNATOR_FAILURE',
  'STARTER_MOTOR',
  'OUT_OF_FUEL',
  'FLAT_TYRE',
  'KEYS_LOCKED_IN',
  'KEY_FAILURE',
  'ENGINE_OVERHEAT',
  'BRAKE_FAILURE',
  'EV_HV_FAULT',
  'IMMOBILISED_UNKNOWN',
] as const;

export type FaultCode = (typeof FAULT_CODES)[number];

// A probability distribution over fault codes. Always normalised to sum to 1.
export type FaultDistribution = Record<FaultCode, number>;

// What a technician must be able to do to resolve each fault. A fault needing
// two capabilities needs BOTH — these are requirements, not alternatives.
const CAPABILITIES_BY_FAULT: Record<FaultCode, string[]> = {
  FLAT_BATTERY: ['JUMP_START'],
  FAILED_BATTERY: ['BATTERY_REPLACEMENT'],
  ALTERNATOR_FAILURE: ['ALTERNATOR_REPLACEMENT'],
  STARTER_MOTOR: ['OBD_DIAGNOSTICS'],
  OUT_OF_FUEL: ['FUEL_DELIVERY'],
  FLAT_TYRE: ['TYRE_CHANGE'],
  KEYS_LOCKED_IN: ['LOCKOUT'],
  KEY_FAILURE: ['KEY_PROGRAMMING'],
  ENGINE_OVERHEAT: ['OBD_DIAGNOSTICS'],
  BRAKE_FAILURE: ['BRAKE_REPAIR'],
  EV_HV_FAULT: ['EV_HV_CERTIFICATION'],
  // Nothing roadside will fix it — the vehicle has to move on a flatbed.
  IMMOBILISED_UNKNOWN: ['FLATBED_LOADING'],
};

export function capabilitiesForFault(fault: FaultCode): string[] {
  return CAPABILITIES_BY_FAULT[fault];
}

// Base rate of each fault across all callouts, before any symptom is known.
// Hand-set from what a roadside operation actually sees: flat batteries and
// flat tyres dominate, specialist EV and key work is rare. These are the
// starting beliefs every classification updates away from.
export const FAULT_PRIORS: FaultDistribution = {
  FLAT_BATTERY: 0.22,
  FLAT_TYRE: 0.18,
  KEYS_LOCKED_IN: 0.1,
  FAILED_BATTERY: 0.09,
  IMMOBILISED_UNKNOWN: 0.08,
  OUT_OF_FUEL: 0.07,
  ENGINE_OVERHEAT: 0.06,
  ALTERNATOR_FAILURE: 0.05,
  STARTER_MOTOR: 0.05,
  KEY_FAILURE: 0.04,
  BRAKE_FAILURE: 0.03,
  EV_HV_FAULT: 0.03,
};

export function isFaultCode(value: string): value is FaultCode {
  return (FAULT_CODES as readonly string[]).includes(value);
}
