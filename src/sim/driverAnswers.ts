// The simulated driver answering an intake question.
//
// The driver knows what is actually wrong — the scenario picked a true fault —
// but only in the sense that their car is behaving that way. So the answer is
// drawn from P(answer | true fault), the same likelihood row the question
// catalogue carries. Sometimes that produces "UNSURE"; sometimes it produces an
// answer that points the wrong way. Both are the point: an intake that only
// ever heard clean, consistent evidence would never have to stop early on a
// question cap, and the question-count distribution would be a straight line.

import type { FaultCode } from '../domain/faults.js';
import { answerLikelihood } from '../domain/questions.js';
import type { IntakeQuestion } from '../domain/questions.js';
import type { Random } from './random.js';

export function answerAsDriver(
  random: Random,
  question: IntakeQuestion,
  trueFault: FaultCode,
): string {
  const weights: Record<string, number> = {};
  for (const answer of question.answers) {
    weights[answer] = answerLikelihood(question, trueFault, answer);
  }
  return random.pickWeighted(weights);
}
