// EXPECTED INFORMATION GAIN — the part of intake that matters.
//
// The problem: given what we currently believe about the fault, which question
// should we ask next? Not "the next one on the form" — the one whose answer we
// expect to leave us least uncertain.
//
// We cannot know the answer in advance, so we average over the answers we might
// get. For a candidate question, for each possible answer:
//   P(answer)  = sum over faults of P(fault) x P(answer | fault)
//   posterior  = Bayes update of our belief, assuming that answer came back
//   H(posterior) = how uncertain we would still be, in bits
// Expected posterior entropy is those entropies weighted by P(answer), and the
// expected information gain is current entropy minus that. Pick the largest.
//
// A question every fault answers identically shifts nothing, so its expected
// gain is zero and it is never chosen. This is why "flat tyre" asks nothing —
// the distribution is already near-certain — and "won't start" asks several.
// PURE CALCULATION. No LLM, no I/O, deterministic, cheap.

import { FAULT_CODES } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';
import { applyLikelihood, shannonEntropy } from './entropy.js';
import { INTAKE_QUESTIONS, answerLikelihood } from './questions.js';
import type { IntakeQuestion } from './questions.js';
import { capabilitySetIsStable } from './capabilitySet.js';

// Below this much uncertainty the diagnosis is good enough to dispatch on.
// Tuned against the rule table: a stated flat tyre lands under it immediately,
// a stated "won't start" needs about three answers to get there.
export const ENTROPY_STOP_THRESHOLD_BITS = 0.65;

// A hard ceiling so a driver giving unhelpful answers is never interrogated.
// Hitting this is a real outcome, not a bug — it is recorded as the stop reason.
export const MAX_QUESTIONS = 5;

// A question expected to buy less than this is not worth a driver's patience.
export const MIN_EXPECTED_GAIN_BITS = 0.02;

export type StopReason =
  | 'ENTROPY_BELOW_THRESHOLD'
  | 'CAPABILITY_SET_STABLE'
  | 'QUESTION_CAP_REACHED'
  | 'NO_INFORMATIVE_QUESTION';

export type QuestionChoice = {
  question: IntakeQuestion;
  expectedGainBits: number;
};

// P(this answer comes back), averaged over every fault we still believe in.
function probabilityOfAnswer(
  distribution: FaultDistribution,
  question: IntakeQuestion,
  answer: string,
): number {
  let total = 0;
  for (const fault of FAULT_CODES) {
    total += distribution[fault] * answerLikelihood(question, fault, answer);
  }
  return total;
}

// What we would believe if this answer came back.
export function posteriorForAnswer(
  distribution: FaultDistribution,
  question: IntakeQuestion,
  answer: string,
): FaultDistribution {
  const likelihood = {} as Record<FaultCode, number>;
  for (const fault of FAULT_CODES) {
    likelihood[fault] = answerLikelihood(question, fault, answer);
  }
  return applyLikelihood(distribution, likelihood);
}

// Entropy we expect to be left with after asking — the weighted average over
// the answers we might get.
export function expectedPosteriorEntropy(
  distribution: FaultDistribution,
  question: IntakeQuestion,
): number {
  let expected = 0;
  for (const answer of question.answers) {
    const answerProbability = probabilityOfAnswer(distribution, question, answer);
    if (answerProbability <= 0) continue;
    const posterior = posteriorForAnswer(distribution, question, answer);
    expected += answerProbability * shannonEntropy(posterior);
  }
  return expected;
}

export function expectedInformationGain(
  distribution: FaultDistribution,
  question: IntakeQuestion,
): number {
  return shannonEntropy(distribution) - expectedPosteriorEntropy(distribution, question);
}

// The three stop conditions, checked in a fixed order. Returns null when intake
// should keep asking.
export function stopReasonFor(
  distribution: FaultDistribution,
  questionsAsked: number,
): StopReason | null {
  if (shannonEntropy(distribution) < ENTROPY_STOP_THRESHOLD_BITS) {
    return 'ENTROPY_BELOW_THRESHOLD';
  }
  if (capabilitySetIsStable(distribution)) {
    return 'CAPABILITY_SET_STABLE';
  }
  if (questionsAsked >= MAX_QUESTIONS) {
    return 'QUESTION_CAP_REACHED';
  }
  return null;
}

// The best question not yet asked, or null when none is worth asking. Ties
// break on catalogue order, so the choice is deterministic.
export function selectNextQuestion(
  distribution: FaultDistribution,
  askedCodes: string[],
): QuestionChoice | null {
  let best: QuestionChoice | null = null;

  for (const question of INTAKE_QUESTIONS) {
    if (askedCodes.includes(question.code)) continue;

    const expectedGainBits = expectedInformationGain(distribution, question);
    if (expectedGainBits < MIN_EXPECTED_GAIN_BITS) continue;
    if (best === null || expectedGainBits > best.expectedGainBits) {
      best = { question, expectedGainBits };
    }
  }

  return best;
}

export type NextQuestionResult =
  | { kind: 'ASK'; choice: QuestionChoice }
  | { kind: 'STOP'; reason: StopReason };

// What intake should do next, given the current belief and what has been asked.
export function decideNextQuestion(
  distribution: FaultDistribution,
  askedCodes: string[],
): NextQuestionResult {
  const stop = stopReasonFor(distribution, askedCodes.length);
  if (stop) return { kind: 'STOP', reason: stop };

  const choice = selectNextQuestion(distribution, askedCodes);
  if (!choice) return { kind: 'STOP', reason: 'NO_INFORMATIVE_QUESTION' };

  return { kind: 'ASK', choice };
}
