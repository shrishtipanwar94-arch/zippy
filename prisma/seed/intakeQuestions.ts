// Mirrors the question catalogue into the database.
//
// The catalogue that MATTERS is the one in src/domain/questions.ts — it carries
// the likelihood tables the entropy calculation runs on, and that has to stay
// in code where it can be unit-tested and read. This table exists so an
// IntakeAnswer row can carry a real foreign key and so an operator can list the
// questions without reading TypeScript. Code is the source of truth; the table
// is a projection of it.

import type { PrismaClient } from '@prisma/client';
import { INTAKE_QUESTIONS } from '../../src/domain/questions.js';
import { FAULT_CODES } from '../../src/domain/faults.js';

export async function seedIntakeQuestions(prisma: PrismaClient): Promise<void> {
  for (const question of INTAKE_QUESTIONS) {
    // The faults this question actually discriminates between — the ones it
    // gives an explicit likelihood row. Everything else it is silent about.
    const faultsAddressed = FAULT_CODES.filter((fault) => question.likelihoods[fault] !== undefined);

    await prisma.intakeQuestion.upsert({
      where: { code: question.code },
      update: {
        prompt: question.prompt,
        answerType: question.answers.join('|'),
        faultsAddressed: [...faultsAddressed],
        active: true,
      },
      create: {
        id: `question-${question.code.toLowerCase()}`,
        code: question.code,
        prompt: question.prompt,
        answerType: question.answers.join('|'),
        faultsAddressed: [...faultsAddressed],
        active: true,
      },
    });
  }
}
