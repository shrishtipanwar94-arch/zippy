// THE RULE TABLE — hand-written, deterministic, no AI anywhere near it.
//
// Turns a symptom payload into a probability distribution over fault codes.
// The method is naive Bayes and it is worth being able to say out loud: start
// from the base rate of each fault (FAULT_PRIORS), then for each thing the
// driver told us multiply every fault by "how likely would I hear THIS if THAT
// fault were the true one", then normalise. Each row below is that likelihood,
// P(observation | fault), read across the faults.
//
// "Naive" means we pretend the observations are independent given the fault.
// They are not — a battery light and a no-crank engine travel together — so
// repeated correlated evidence makes the result overconfident. At twelve faults
// and five observations that is a rounding error against a table anyone can
// read, and reading it is what matters. It is recorded as a weakness.
//
// Phase 16 replaces the INPUT to this file (free text -> LLM -> SymptomPayload),
// never this table.

import { FAULT_CODES, FAULT_PRIORS } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';
import { applyLikelihood } from './entropy.js';
import type { SymptomPayload } from './symptoms.js';

// A partial likelihood row. Faults left out take `DEFAULT_LIKELIHOOD` — the
// observation says nothing about them either way, so they are neither
// promoted nor ruled out.
type LikelihoodRow = Partial<Record<FaultCode, number>>;

const DEFAULT_LIKELIHOOD = 0.1;

function expand(row: LikelihoodRow): Record<FaultCode, number> {
  const full = {} as Record<FaultCode, number>;
  for (const fault of FAULT_CODES) {
    full[fault] = row[fault] ?? DEFAULT_LIKELIHOOD;
  }
  return full;
}

// P(driver says this complaint | fault is the true one).
const COMPLAINT_LIKELIHOOD: Record<SymptomPayload['primaryComplaint'], LikelihoodRow> = {
  WONT_START: {
    FLAT_BATTERY: 0.85,
    FAILED_BATTERY: 0.85,
    STARTER_MOTOR: 0.9,
    OUT_OF_FUEL: 0.8,
    KEY_FAILURE: 0.7,
    ALTERNATOR_FAILURE: 0.5,
    EV_HV_FAULT: 0.4,
    IMMOBILISED_UNKNOWN: 0.2,
    ENGINE_OVERHEAT: 0.1,
    BRAKE_FAILURE: 0.05,
    KEYS_LOCKED_IN: 0.02,
    FLAT_TYRE: 0.01,
  },
  FLAT_TYRE: {
    FLAT_TYRE: 0.95,
    IMMOBILISED_UNKNOWN: 0.05,
    FLAT_BATTERY: 0.01,
    FAILED_BATTERY: 0.01,
    ALTERNATOR_FAILURE: 0.01,
    STARTER_MOTOR: 0.01,
    OUT_OF_FUEL: 0.01,
    KEYS_LOCKED_IN: 0.01,
    KEY_FAILURE: 0.01,
    ENGINE_OVERHEAT: 0.01,
    BRAKE_FAILURE: 0.01,
    EV_HV_FAULT: 0.01,
  },
  LOCKED_OUT: {
    KEYS_LOCKED_IN: 0.92,
    KEY_FAILURE: 0.3,
    IMMOBILISED_UNKNOWN: 0.02,
    FLAT_BATTERY: 0.01,
    FAILED_BATTERY: 0.01,
    ALTERNATOR_FAILURE: 0.01,
    STARTER_MOTOR: 0.01,
    OUT_OF_FUEL: 0.01,
    FLAT_TYRE: 0.01,
    ENGINE_OVERHEAT: 0.01,
    BRAKE_FAILURE: 0.01,
    EV_HV_FAULT: 0.01,
  },
  WARNING_LIGHT: {
    ALTERNATOR_FAILURE: 0.6,
    ENGINE_OVERHEAT: 0.6,
    EV_HV_FAULT: 0.6,
    BRAKE_FAILURE: 0.5,
    FAILED_BATTERY: 0.3,
    FLAT_BATTERY: 0.2,
    STARTER_MOTOR: 0.1,
    OUT_OF_FUEL: 0.15,
    IMMOBILISED_UNKNOWN: 0.1,
    KEY_FAILURE: 0.1,
    FLAT_TYRE: 0.05,
    KEYS_LOCKED_IN: 0.01,
  },
  NOISE_OR_SMELL: {
    ENGINE_OVERHEAT: 0.7,
    BRAKE_FAILURE: 0.6,
    STARTER_MOTOR: 0.4,
    ALTERNATOR_FAILURE: 0.35,
    EV_HV_FAULT: 0.3,
    IMMOBILISED_UNKNOWN: 0.2,
    FLAT_TYRE: 0.15,
    FLAT_BATTERY: 0.05,
    FAILED_BATTERY: 0.05,
    OUT_OF_FUEL: 0.05,
    KEY_FAILURE: 0.02,
    KEYS_LOCKED_IN: 0.01,
  },
  STUCK_OR_DAMAGED: {
    IMMOBILISED_UNKNOWN: 0.85,
    FLAT_TYRE: 0.25,
    BRAKE_FAILURE: 0.2,
    ENGINE_OVERHEAT: 0.1,
    EV_HV_FAULT: 0.1,
    FLAT_BATTERY: 0.02,
    FAILED_BATTERY: 0.02,
    ALTERNATOR_FAILURE: 0.02,
    STARTER_MOTOR: 0.02,
    OUT_OF_FUEL: 0.02,
    KEYS_LOCKED_IN: 0.01,
    KEY_FAILURE: 0.01,
  },
  // The driver cannot characterise it. Deliberately flat: it tells us nothing,
  // so the distribution stays at the base rates and intake asks questions.
  UNKNOWN: {},
};

// P(engine turns over like this | fault). The single most diagnostic question
// on the no-start path: a cranking engine rules batteries out and fuel in.
const ENGINE_CRANKS_LIKELIHOOD: Record<'YES' | 'NO' | 'UNSURE', LikelihoodRow> = {
  YES: {
    OUT_OF_FUEL: 0.9,
    ENGINE_OVERHEAT: 0.7,
    STARTER_MOTOR: 0.1,
    FLAT_BATTERY: 0.08,
    FAILED_BATTERY: 0.05,
    ALTERNATOR_FAILURE: 0.35,
    KEY_FAILURE: 0.1,
    EV_HV_FAULT: 0.1,
    IMMOBILISED_UNKNOWN: 0.4,
    FLAT_TYRE: 0.5,
    KEYS_LOCKED_IN: 0.3,
    BRAKE_FAILURE: 0.5,
  },
  NO: {
    FLAT_BATTERY: 0.87,
    FAILED_BATTERY: 0.9,
    STARTER_MOTOR: 0.85,
    KEY_FAILURE: 0.85,
    ALTERNATOR_FAILURE: 0.6,
    EV_HV_FAULT: 0.85,
    OUT_OF_FUEL: 0.05,
    ENGINE_OVERHEAT: 0.25,
    IMMOBILISED_UNKNOWN: 0.5,
    FLAT_TYRE: 0.4,
    KEYS_LOCKED_IN: 0.6,
    BRAKE_FAILURE: 0.4,
  },
  // "I could not tell" is weak evidence, not no evidence — it is more common
  // when the car is silent than when it audibly cranks.
  UNSURE: {
    FLAT_BATTERY: 0.05,
    FAILED_BATTERY: 0.05,
    STARTER_MOTOR: 0.05,
    KEY_FAILURE: 0.05,
    ALTERNATOR_FAILURE: 0.05,
    EV_HV_FAULT: 0.05,
    OUT_OF_FUEL: 0.05,
    ENGINE_OVERHEAT: 0.05,
    IMMOBILISED_UNKNOWN: 0.1,
    FLAT_TYRE: 0.1,
    KEYS_LOCKED_IN: 0.1,
    BRAKE_FAILURE: 0.1,
  },
};

// P(this light is lit | fault). Applied once per light the driver reports, so
// two lights are two updates.
const WARNING_LIGHT_LIKELIHOOD: Record<string, LikelihoodRow> = {
  BATTERY: { ALTERNATOR_FAILURE: 0.9, FAILED_BATTERY: 0.5, FLAT_BATTERY: 0.35, EV_HV_FAULT: 0.1 },
  ENGINE: { STARTER_MOTOR: 0.4, ENGINE_OVERHEAT: 0.5, OUT_OF_FUEL: 0.3, EV_HV_FAULT: 0.2 },
  TEMPERATURE: { ENGINE_OVERHEAT: 0.95, EV_HV_FAULT: 0.15 },
  OIL: { ENGINE_OVERHEAT: 0.4, IMMOBILISED_UNKNOWN: 0.2 },
  BRAKE: { BRAKE_FAILURE: 0.9 },
  EV_SYSTEM: { EV_HV_FAULT: 0.95 },
};

// P(driver hears this | fault).
const SOUND_LIKELIHOOD: Record<string, LikelihoodRow> = {
  NONE: {
    FLAT_BATTERY: 0.3,
    FAILED_BATTERY: 0.45,
    KEY_FAILURE: 0.8,
    EV_HV_FAULT: 0.7,
    OUT_OF_FUEL: 0.6,
    KEYS_LOCKED_IN: 0.8,
    FLAT_TYRE: 0.6,
    STARTER_MOTOR: 0.1,
    ALTERNATOR_FAILURE: 0.3,
    ENGINE_OVERHEAT: 0.2,
    BRAKE_FAILURE: 0.2,
    IMMOBILISED_UNKNOWN: 0.4,
  },
  // The classic flat-battery signature: the solenoid clicks, the engine does
  // not turn.
  CLICKING: {
    FLAT_BATTERY: 0.75,
    FAILED_BATTERY: 0.6,
    STARTER_MOTOR: 0.5,
    ALTERNATOR_FAILURE: 0.15,
    EV_HV_FAULT: 0.05,
    KEY_FAILURE: 0.05,
    OUT_OF_FUEL: 0.03,
    ENGINE_OVERHEAT: 0.03,
    KEYS_LOCKED_IN: 0.02,
    FLAT_TYRE: 0.02,
    BRAKE_FAILURE: 0.05,
    IMMOBILISED_UNKNOWN: 0.1,
  },
  GRINDING: {
    STARTER_MOTOR: 0.8,
    BRAKE_FAILURE: 0.6,
    IMMOBILISED_UNKNOWN: 0.2,
    FLAT_TYRE: 0.2,
    FLAT_BATTERY: 0.03,
    FAILED_BATTERY: 0.03,
    ALTERNATOR_FAILURE: 0.1,
    OUT_OF_FUEL: 0.02,
    ENGINE_OVERHEAT: 0.05,
    KEY_FAILURE: 0.02,
    KEYS_LOCKED_IN: 0.01,
    EV_HV_FAULT: 0.05,
  },
  WHINING: {
    ALTERNATOR_FAILURE: 0.75,
    EV_HV_FAULT: 0.2,
    STARTER_MOTOR: 0.15,
    ENGINE_OVERHEAT: 0.1,
    FLAT_BATTERY: 0.05,
    FAILED_BATTERY: 0.05,
    OUT_OF_FUEL: 0.03,
    KEY_FAILURE: 0.02,
    KEYS_LOCKED_IN: 0.01,
    FLAT_TYRE: 0.02,
    BRAKE_FAILURE: 0.05,
    IMMOBILISED_UNKNOWN: 0.1,
  },
  BANG: {
    IMMOBILISED_UNKNOWN: 0.6,
    FLAT_TYRE: 0.5,
    BRAKE_FAILURE: 0.2,
    ENGINE_OVERHEAT: 0.15,
    EV_HV_FAULT: 0.1,
    FLAT_BATTERY: 0.02,
    FAILED_BATTERY: 0.02,
    ALTERNATOR_FAILURE: 0.05,
    STARTER_MOTOR: 0.05,
    OUT_OF_FUEL: 0.02,
    KEY_FAILURE: 0.01,
    KEYS_LOCKED_IN: 0.01,
  },
  // Carries no information by construction — listed so the answer is legal.
  UNSURE: {},
};

// P(the car can still be driven | fault).
const VEHICLE_MOVES_LIKELIHOOD: Record<'true' | 'false', LikelihoodRow> = {
  true: {
    ENGINE_OVERHEAT: 0.5,
    BRAKE_FAILURE: 0.3,
    ALTERNATOR_FAILURE: 0.4,
    FLAT_TYRE: 0.15,
    OUT_OF_FUEL: 0.05,
    FLAT_BATTERY: 0.05,
    FAILED_BATTERY: 0.03,
    STARTER_MOTOR: 0.05,
    KEY_FAILURE: 0.05,
    KEYS_LOCKED_IN: 0.05,
    EV_HV_FAULT: 0.15,
    IMMOBILISED_UNKNOWN: 0.02,
  },
  false: {
    ENGINE_OVERHEAT: 0.5,
    BRAKE_FAILURE: 0.7,
    ALTERNATOR_FAILURE: 0.6,
    FLAT_TYRE: 0.85,
    OUT_OF_FUEL: 0.95,
    FLAT_BATTERY: 0.95,
    FAILED_BATTERY: 0.97,
    STARTER_MOTOR: 0.95,
    KEY_FAILURE: 0.95,
    KEYS_LOCKED_IN: 0.95,
    EV_HV_FAULT: 0.85,
    IMMOBILISED_UNKNOWN: 0.98,
  },
};

// The one entry point. Every observation present in the payload is folded into
// the priors in a fixed order, so the same payload always yields the same
// distribution — Phase 10's harness replays these.
export function classifySymptoms(symptoms: SymptomPayload): FaultDistribution {
  let distribution: FaultDistribution = { ...FAULT_PRIORS };

  distribution = applyLikelihood(
    distribution,
    expand(COMPLAINT_LIKELIHOOD[symptoms.primaryComplaint]),
  );

  if (symptoms.engineCranks !== null) {
    distribution = applyLikelihood(
      distribution,
      expand(ENGINE_CRANKS_LIKELIHOOD[symptoms.engineCranks]),
    );
  }

  for (const light of symptoms.warningLights) {
    const row = WARNING_LIGHT_LIKELIHOOD[light];
    if (row) {
      distribution = applyLikelihood(distribution, expand(row));
    }
  }

  if (symptoms.unusualSound !== null) {
    const row = SOUND_LIKELIHOOD[symptoms.unusualSound];
    if (row) {
      distribution = applyLikelihood(distribution, expand(row));
    }
  }

  if (symptoms.vehicleMoves !== null) {
    distribution = applyLikelihood(
      distribution,
      expand(VEHICLE_MOVES_LIKELIHOOD[symptoms.vehicleMoves ? 'true' : 'false']),
    );
  }

  return distribution;
}

// THE SAME TABLE, READ THE OTHER WAY.
//
// `classifySymptoms` goes from observations to faults. The simulator needs the
// generative direction — "if the true fault were X, how likely is the driver to
// report Y" — so it can invent a breakdown and then produce plausible symptoms
// for it. That is exactly a cell of these tables, so it is exposed here rather
// than duplicated in src/sim, where the two copies would drift apart.
//
// Sampling from the model the classifier inverts is worth being honest about:
// it measures how well entropy-driven questioning searches the model, not how
// well the model matches real breakdowns. Recorded as a weakness.
export type SymptomField = 'engineCranks' | 'warningLight' | 'unusualSound' | 'vehicleMoves';

export function symptomLikelihood(field: SymptomField, value: string, fault: FaultCode): number {
  if (field === 'engineCranks') {
    const row = ENGINE_CRANKS_LIKELIHOOD[value as 'YES' | 'NO' | 'UNSURE'];
    return row ? (row[fault] ?? DEFAULT_LIKELIHOOD) : DEFAULT_LIKELIHOOD;
  }
  if (field === 'warningLight') {
    const row = WARNING_LIGHT_LIKELIHOOD[value];
    return row ? (row[fault] ?? DEFAULT_LIKELIHOOD) : DEFAULT_LIKELIHOOD;
  }
  if (field === 'unusualSound') {
    const row = SOUND_LIKELIHOOD[value];
    return row ? (row[fault] ?? DEFAULT_LIKELIHOOD) : DEFAULT_LIKELIHOOD;
  }
  const row = VEHICLE_MOVES_LIKELIHOOD[value as 'true' | 'false'];
  return row ? (row[fault] ?? DEFAULT_LIKELIHOOD) : DEFAULT_LIKELIHOOD;
}
