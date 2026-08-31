// The state one job's intake is in: what we currently believe, what has already
// been asked, and therefore what should happen next. Read by the
// next-question route and by the answer path before it accepts anything.
//
// The decision itself is pure and lives in src/domain/questionSelection.ts.
// This file only fetches the two inputs that decision needs out of Postgres.

import type { Prisma } from '@prisma/client';
import { decideNextQuestion } from '../domain/questionSelection.js';
import type { NextQuestionResult } from '../domain/questionSelection.js';
import { answerOptions } from '../domain/answerLabels.js';
import type { AnswerOption } from '../domain/answerLabels.js';
import { latestHypothesis } from './hypothesis.js';
import type { StoredHypothesis } from './hypothesis.js';
import { IntakeError } from './errors.js';

export type IntakeSession = {
  jobId: string;
  hypothesis: StoredHypothesis;
  askedCodes: string[];
};

export async function loadIntakeSession(
  db: Prisma.TransactionClient,
  jobId: string,
): Promise<IntakeSession> {
  const hypothesis = await latestHypothesis(db, jobId);
  if (!hypothesis) {
    throw new IntakeError('JOB_NOT_FOUND', `no fault hypothesis exists for job ${jobId}`);
  }

  const answers = await db.intakeAnswer.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
    select: { questionCode: true },
  });

  return {
    jobId,
    hypothesis,
    askedCodes: answers.map((answer) => answer.questionCode),
  };
}

export function nextStepFor(session: IntakeSession): NextQuestionResult {
  return decideNextQuestion(session.hypothesis.distribution, session.askedCodes);
}

// The shape both the intake response and GET /jobs/:id/next-question return.
// `done` is the flag a client branches on; `reason` says which of the three
// stop conditions fired, because "we stopped asking" and "we ran out of
// patience" are different outcomes to an operator.
export type NextQuestionView =
  | {
      done: false;
      // ANSWERS CARRY THEIR WORDS. The domain keeps answer CODES, because
      // the likelihood tables are keyed on them; the view adds the label a
      // driver reads, so no client ever has to map one to the other. See
      // src/domain/answerLabels.ts for why that translation is here.
      question: { code: string; prompt: string; answers: AnswerOption[] };
      expectedGainBits: number;
      questionsAsked: number;
      entropyBits: number;
    }
  | {
      done: true;
      reason: string;
      questionsAsked: number;
      entropyBits: number;
    };

export function nextQuestionView(session: IntakeSession): NextQuestionView {
  const step = nextStepFor(session);
  const questionsAsked = session.askedCodes.length;
  const entropyBits = session.hypothesis.entropy;

  if (step.kind === 'STOP') {
    return { done: true, reason: step.reason, questionsAsked, entropyBits };
  }

  return {
    done: false,
    question: {
      code: step.choice.question.code,
      prompt: step.choice.question.prompt,
      answers: answerOptions(step.choice.question.answers),
    },
    expectedGainBits: step.choice.expectedGainBits,
    questionsAsked,
    entropyBits,
  };
}
