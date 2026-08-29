// THE QUESTION CATALOGUE. Intake picks from this fixed set — it never invents a
// question, and no LLM is involved (invariant 5, and Phase 3 has no AI at all).
//
// Each question carries, for every fault, the probability of hearing each
// answer IF that fault were the true one: P(answer | fault). The selector in
// questionSelection.ts uses exactly this to work out which question would tell
// it the most. A question is only worth asking when its answers differ between
// the faults still in contention — a question every fault answers the same way
// has zero information gain and will never be picked.
//
// INVARIANT: every likelihood row sums to 1 across that question's answers.
// They are probabilities of mutually exclusive answers to the same question.
// A test asserts this on every row.
//
// A fault absent from a question's `likelihoods` is treated as UNIFORM over
// that question's answers — every answer equally likely. That is the precise
// meaning of "this question tells us nothing about that fault": whatever comes
// back multiplies it by the same constant, so its probability relative to the
// other unlisted faults is unchanged and only the explicitly modelled faults
// move. Do not be tempted to write a "normal-looking" default row instead: a
// default that says NO/SILENCE/HAS_FUEL is likely quietly promotes every fault
// the question forgot to mention, every time a driver reports nothing unusual,
// and the most-forgotten fault wins the diagnosis. That bug was in this file
// once and it made a stuck vehicle look like a flat tyre.

import type { FaultCode } from './faults.js';

export type IntakeQuestion = {
  code: string;
  prompt: string;
  answers: string[];
  likelihoods: Partial<Record<FaultCode, Record<string, number>>>;
};

export const INTAKE_QUESTIONS: IntakeQuestion[] = [
  {
    code: 'ENGINE_CRANKS',
    prompt: 'When you turn the key or press start, does the engine turn over at all?',
    answers: ['YES', 'NO', 'UNSURE'],
    likelihoods: {
      FLAT_BATTERY: { YES: 0.08, NO: 0.87, UNSURE: 0.05 },
      FAILED_BATTERY: { YES: 0.05, NO: 0.9, UNSURE: 0.05 },
      ALTERNATOR_FAILURE: { YES: 0.35, NO: 0.6, UNSURE: 0.05 },
      STARTER_MOTOR: { YES: 0.1, NO: 0.85, UNSURE: 0.05 },
      OUT_OF_FUEL: { YES: 0.9, NO: 0.05, UNSURE: 0.05 },
      KEY_FAILURE: { YES: 0.1, NO: 0.85, UNSURE: 0.05 },
      EV_HV_FAULT: { YES: 0.1, NO: 0.85, UNSURE: 0.05 },
      ENGINE_OVERHEAT: { YES: 0.7, NO: 0.25, UNSURE: 0.05 },
      IMMOBILISED_UNKNOWN: { YES: 0.4, NO: 0.5, UNSURE: 0.1 },
    },
  },
  {
    code: 'DASH_LIGHTS',
    prompt: 'Do the dashboard lights come on, and are they bright or dim?',
    answers: ['BRIGHT', 'DIM_OR_NONE', 'UNSURE'],
    likelihoods: {
      FLAT_BATTERY: { BRIGHT: 0.15, DIM_OR_NONE: 0.8, UNSURE: 0.05 },
      FAILED_BATTERY: { BRIGHT: 0.1, DIM_OR_NONE: 0.85, UNSURE: 0.05 },
      ALTERNATOR_FAILURE: { BRIGHT: 0.35, DIM_OR_NONE: 0.6, UNSURE: 0.05 },
      STARTER_MOTOR: { BRIGHT: 0.85, DIM_OR_NONE: 0.1, UNSURE: 0.05 },
      OUT_OF_FUEL: { BRIGHT: 0.9, DIM_OR_NONE: 0.05, UNSURE: 0.05 },
      KEY_FAILURE: { BRIGHT: 0.85, DIM_OR_NONE: 0.1, UNSURE: 0.05 },
      EV_HV_FAULT: { BRIGHT: 0.6, DIM_OR_NONE: 0.35, UNSURE: 0.05 },
      // The driver is outside the locked car and often cannot see the dash.
      KEYS_LOCKED_IN: { BRIGHT: 0.45, DIM_OR_NONE: 0.15, UNSURE: 0.4 },
      IMMOBILISED_UNKNOWN: { BRIGHT: 0.55, DIM_OR_NONE: 0.3, UNSURE: 0.15 },
    },
  },
  {
    code: 'STARTER_SOUND',
    prompt: 'What do you hear when you try to start it?',
    answers: ['CLICKING', 'GRINDING', 'SILENCE', 'OTHER'],
    likelihoods: {
      // A solenoid clicking while the engine will not turn is the classic
      // flat-battery signature — the highest-information answer in the set.
      FLAT_BATTERY: { CLICKING: 0.7, GRINDING: 0.03, SILENCE: 0.22, OTHER: 0.05 },
      FAILED_BATTERY: { CLICKING: 0.55, GRINDING: 0.03, SILENCE: 0.37, OTHER: 0.05 },
      ALTERNATOR_FAILURE: { CLICKING: 0.25, GRINDING: 0.1, SILENCE: 0.35, OTHER: 0.3 },
      STARTER_MOTOR: { CLICKING: 0.3, GRINDING: 0.5, SILENCE: 0.1, OTHER: 0.1 },
      // Cranks healthily but never fires — audibly different from a click.
      OUT_OF_FUEL: { CLICKING: 0.03, GRINDING: 0.02, SILENCE: 0.15, OTHER: 0.8 },
      KEY_FAILURE: { CLICKING: 0.05, GRINDING: 0.02, SILENCE: 0.83, OTHER: 0.1 },
      KEYS_LOCKED_IN: { CLICKING: 0.02, GRINDING: 0.01, SILENCE: 0.87, OTHER: 0.1 },
      EV_HV_FAULT: { CLICKING: 0.05, GRINDING: 0.02, SILENCE: 0.83, OTHER: 0.1 },
      ENGINE_OVERHEAT: { CLICKING: 0.03, GRINDING: 0.05, SILENCE: 0.22, OTHER: 0.7 },
      BRAKE_FAILURE: { CLICKING: 0.03, GRINDING: 0.5, SILENCE: 0.27, OTHER: 0.2 },
      IMMOBILISED_UNKNOWN: { CLICKING: 0.1, GRINDING: 0.2, SILENCE: 0.4, OTHER: 0.3 },
    },
  },
  {
    code: 'FUEL_GAUGE',
    prompt: 'What does the fuel gauge read?',
    answers: ['HAS_FUEL', 'EMPTY', 'UNSURE'],
    likelihoods: {
      OUT_OF_FUEL: { HAS_FUEL: 0.05, EMPTY: 0.9, UNSURE: 0.05 },
      // With a dead battery the gauge itself may not read at all.
      FLAT_BATTERY: { HAS_FUEL: 0.75, EMPTY: 0.08, UNSURE: 0.17 },
      FAILED_BATTERY: { HAS_FUEL: 0.7, EMPTY: 0.08, UNSURE: 0.22 },
      KEYS_LOCKED_IN: { HAS_FUEL: 0.55, EMPTY: 0.05, UNSURE: 0.4 },
      EV_HV_FAULT: { HAS_FUEL: 0.65, EMPTY: 0.05, UNSURE: 0.3 },
    },
  },
  {
    code: 'BATTERY_LIGHT_BEFORE',
    prompt: 'Before it stopped, was the battery or charging light on while you were driving?',
    answers: ['YES', 'NO', 'UNSURE'],
    likelihoods: {
      // A charge warning while still driving is what separates a failing
      // alternator from a simply flat battery.
      ALTERNATOR_FAILURE: { YES: 0.85, NO: 0.1, UNSURE: 0.05 },
      FAILED_BATTERY: { YES: 0.4, NO: 0.5, UNSURE: 0.1 },
      FLAT_BATTERY: { YES: 0.2, NO: 0.7, UNSURE: 0.1 },
      EV_HV_FAULT: { YES: 0.25, NO: 0.65, UNSURE: 0.1 },
    },
  },
  {
    code: 'KEY_RECOGNISED',
    prompt: 'Does the car show a "key not detected" message?',
    answers: ['KEY_NOT_DETECTED', 'NORMAL', 'UNSURE'],
    likelihoods: {
      KEY_FAILURE: { KEY_NOT_DETECTED: 0.85, NORMAL: 0.1, UNSURE: 0.05 },
      KEYS_LOCKED_IN: { KEY_NOT_DETECTED: 0.1, NORMAL: 0.2, UNSURE: 0.7 },
      FLAT_BATTERY: { KEY_NOT_DETECTED: 0.1, NORMAL: 0.65, UNSURE: 0.25 },
      FAILED_BATTERY: { KEY_NOT_DETECTED: 0.1, NORMAL: 0.6, UNSURE: 0.3 },
    },
  },
  {
    code: 'HEAT_OR_STEAM',
    prompt: 'Is the temperature gauge high, or is there steam or a burning smell?',
    answers: ['YES', 'NO', 'UNSURE'],
    likelihoods: {
      ENGINE_OVERHEAT: { YES: 0.9, NO: 0.05, UNSURE: 0.05 },
      EV_HV_FAULT: { YES: 0.2, NO: 0.7, UNSURE: 0.1 },
      IMMOBILISED_UNKNOWN: { YES: 0.15, NO: 0.75, UNSURE: 0.1 },
    },
  },
];

export function findQuestion(code: string): IntakeQuestion | undefined {
  return INTAKE_QUESTIONS.find((question) => question.code === code);
}

// P(answer | fault) for one question. A fault the question does not model is
// uniform across its answers — see the header: uninformative, not "normal".
export function answerLikelihood(
  question: IntakeQuestion,
  fault: FaultCode,
  answer: string,
): number {
  const row = question.likelihoods[fault];
  if (!row) return 1 / question.answers.length;
  return row[answer] ?? 0;
}
