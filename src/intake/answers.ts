// Recording one answer, and deciding what to ask next.
//
// The entropy before and after the answer is stored on the row. That is what
// makes the claim "questions are chosen by information gain" measurable rather
// than decorative: the Phase 10 harness reads these two columns.
//
// WORTH KNOWING, because it looks like a bug the first time you see it:
// entropy_after is USUALLY lower than entropy_before, but not always. Expected
// information gain is non-negative by construction — that is a theorem about
// the AVERAGE over the answers we might get. A particular answer can still
// leave us less sure than we were: if we were fairly confident it was a flat
// battery and the driver says the dash lights are bright, that confidence was
// misplaced and the honest posterior is flatter than the prior. A system where
// no answer ever surprised it would be a system that was not listening. What
// must hold is that the mean realised gain is positive and that intake ends
// less uncertain than it started — both are asserted in tests/intake.test.ts.

import type { Prisma, PrismaClient } from '@prisma/client';
import { shannonEntropy } from '../domain/entropy.js';
import { expectedInformationGain, posteriorForAnswer } from '../domain/questionSelection.js';
import { appendJobEvent } from './events.js';
import { recordHypothesis } from './hypothesis.js';
import { runIntakeTransaction } from './transaction.js';
import { loadIntakeSession, nextQuestionView, nextStepFor } from './session.js';
import type { NextQuestionView } from './session.js';
import { IntakeError } from './errors.js';
import type { IntakeActor } from './createJob.js';

export type AnswerRequest = {
  jobId: string;
  questionCode: string;
  answer: string;
  actor: IntakeActor;
  at: Date;
};

export type AnswerResult = {
  questionCode: string;
  answer: string;
  entropyBeforeBits: number;
  entropyAfterBits: number;
  expectedGainBits: number;
  topFault: string;
  requiredCapabilityCodes: string[];
  next: NextQuestionView;
};

export async function recordIntakeAnswer(
  db: PrismaClient,
  request: AnswerRequest,
): Promise<AnswerResult> {
  return runIntakeTransaction(db, async (tx) => {
    const session = await loadIntakeSession(tx, request.jobId);
    const step = nextStepFor(session);

    // An answer is only accepted for the question intake is actually waiting
    // on. Otherwise a stale client — or a replayed request — could fold the
    // same evidence in twice and manufacture confidence that was never earned.
    if (step.kind === 'STOP') {
      throw new IntakeError('INTAKE_ALREADY_COMPLETE', `intake for job ${request.jobId} has ended`);
    }
    const question = step.choice.question;
    if (question.code !== request.questionCode) {
      throw new IntakeError(
        'QUESTION_NOT_PENDING',
        `job ${request.jobId} is waiting on ${question.code}, not ${request.questionCode}`,
      );
    }
    if (!question.answers.includes(request.answer)) {
      throw new IntakeError(
        'ANSWER_NOT_ALLOWED',
        `${request.answer} is not one of ${question.answers.join(', ')}`,
      );
    }

    const prior = session.hypothesis.distribution;
    const entropyBefore = shannonEntropy(prior);
    const expectedGain = expectedInformationGain(prior, question);
    const posterior = posteriorForAnswer(prior, question, request.answer);
    const entropyAfter = shannonEntropy(posterior);

    const catalogueRow = await tx.intakeQuestion.findUnique({
      where: { code: question.code },
      select: { id: true },
    });

    await tx.intakeAnswer.create({
      data: {
        jobId: request.jobId,
        questionId: catalogueRow?.id ?? null,
        questionCode: question.code,
        answer: request.answer,
        entropyBefore,
        entropyAfter,
        expectedGain,
        createdAt: request.at,
      },
    });

    const hypothesis = await recordHypothesis(tx, request.jobId, posterior);

    const common = {
      jobId: request.jobId,
      actorRole: request.actor?.role ?? null,
      actorId: request.actor?.id ?? null,
      at: request.at,
    };

    await appendJobEvent(tx, {
      ...common,
      eventType: 'INTAKE_ANSWER_RECORDED',
      payload: {
        questionCode: question.code,
        answer: request.answer,
        entropyBeforeBits: entropyBefore,
        entropyAfterBits: entropyAfter,
        expectedGainBits: expectedGain,
      },
    });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'FAULT_HYPOTHESIS_UPDATED',
      payload: {
        version: hypothesis.version,
        entropyBits: hypothesis.entropy,
        topFault: hypothesis.topFault,
        requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
      },
    });

    // As in createJob: the updated belief is already in hand, so the next step
    // is computed from it rather than read back inside the transaction.
    const askedCodes = [...session.askedCodes, question.code];
    const next = nextQuestionView({ jobId: request.jobId, hypothesis, askedCodes });

    if (next.done) {
      await appendJobEvent(tx, {
        ...common,
        eventType: 'INTAKE_COMPLETED',
        payload: {
          reason: next.reason,
          questionsAsked: askedCodes.length,
          entropyBits: hypothesis.entropy,
          requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
        },
      });
    }

    return {
      questionCode: question.code,
      answer: request.answer,
      entropyBeforeBits: entropyBefore,
      entropyAfterBits: entropyAfter,
      expectedGainBits: expectedGain,
      topFault: hypothesis.topFault,
      requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
      next,
    };
  });
}

// GET /jobs/:id/next-question, once the route has established the caller may
// see the job at all.
export async function nextQuestionFor(
  db: Prisma.TransactionClient,
  jobId: string,
): Promise<NextQuestionView> {
  const session = await loadIntakeSession(db, jobId);
  return nextQuestionView(session);
}
