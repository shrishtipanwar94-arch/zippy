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

// ---------------------------------------------------------------------------
// WHAT A REPAIR CONSUMES — the estimate's half of "what does this fault need".
//
// The map above answers "what SKILL do we send"; this answers "what PARTS get
// used up", and they sit together because they are the same question asked by
// two different consumers. Dispatch reads the first and has no use for the
// second — a van is chosen by what its crew can do, not by what the job will
// bill — while the estimate builder (Phase 15c) reads this one.
//
// BY SKU, not by part id, because the id is a database key the seed happens to
// generate and the SKU is the thing a parts catalogue is actually organised
// around. `prisma/seed/parts.ts` owns the list these must match.
//
// AN EMPTY LIST IS A REAL ANSWER, and four faults have one. A jump start
// consumes nothing — the leads are equipment, not stock. A lockout consumes
// nothing. A tow consumes nothing; the tow itself is the charge. Those jobs
// are labour and a callout, and an estimate that invented a part for them
// would be wrong in the direction that costs the customer money.
//
// Quantities are one of each. A repair needing two of something is real (two
// front brake pads are already a "set") and is not modelled: the technician
// revising the estimate is the mechanism for anything the table did not
// predict, which is the whole point of the re-approval loop.
const PARTS_BY_FAULT: Record<FaultCode, string[]> = {
  FLAT_BATTERY: [],
  FAILED_BATTERY: ['BAT-45AH'],
  ALTERNATOR_FAILURE: ['ALT-RECON', 'DRIVE-BELT'],
  STARTER_MOTOR: ['STR-MOTOR-RECON'],
  OUT_OF_FUEL: ['PETROL-5L'],
  FLAT_TYRE: ['TYRE-REPAIR-KIT'],
  KEYS_LOCKED_IN: [],
  KEY_FAILURE: ['KEY-FOB-BLANK'],
  ENGINE_OVERHEAT: ['COOLANT-5L'],
  BRAKE_FAILURE: ['BRK-PAD-FRONT', 'BRK-FLUID-DOT4'],
  EV_HV_FAULT: [],
  IMMOBILISED_UNKNOWN: [],
};

export function partSkusForFault(fault: FaultCode): string[] {
  return PARTS_BY_FAULT[fault];
}

// WHICH LABOUR RATE APPLIES. Two codes exist on the seeded price list —
// STANDARD and SPECIALIST — and the split is by whether the work needs a
// certification rather than by how long it takes. High-voltage work, key
// programming and brakes are the three a workshop would not let an
// uncertified technician touch; everything else is standard roadside labour.
// Hand-set, like the durations in src/engine/durations.ts, and for the same
// reason: there is no historical data to fit it to.
const SPECIALIST_FAULTS: ReadonlySet<FaultCode> = new Set<FaultCode>([
  'EV_HV_FAULT',
  'KEY_FAILURE',
  'BRAKE_FAILURE',
]);

export function labourCodeForFault(fault: FaultCode): string {
  return SPECIALIST_FAULTS.has(fault) ? 'SPECIALIST' : 'STANDARD';
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
