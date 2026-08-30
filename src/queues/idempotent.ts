// "EVERY PROCESSOR IS IDEMPOTENT. RE-RUNNING MUST NOT DUPLICATE EFFECTS."
//
// BullMQ delivers a job AT LEAST once — a worker can finish the work, then
// crash before acknowledging it, and the same job is handed to the next
// worker. A retry after a transient failure and a redelivery after a crash
// look identical to the processor: the same idempotency key, arriving again.
//
// `runIdempotently` is the one place that question gets answered, and it
// answers it with a database constraint rather than an in-memory check — an
// in-memory "have I seen this key" set is exactly the kind of state that a
// crash erases at precisely the moment it would have mattered.
//
// THE EFFECT AND THE LOG ROW COMMIT TOGETHER. `effect` runs inside the same
// Postgres transaction as the `job_processing_log` insert. If `effect` throws,
// the transaction rolls back and the log insert rolls back with it — so a
// half-applied effect is never recorded as done, and the next delivery retries
// it for real. This works because every effect in this phase is itself a
// Postgres write (or nothing at all). A processor whose real effect is
// external — an HTTP call to a payment provider, an SMS send — cannot be made
// atomic with a Postgres transaction this way; that processor needs a
// two-phase version of this (reserve the key, make the call, then mark
// delivered) and is deliberately not what this function is for. None of
// today's processors do that yet.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prismaBase } from '../infra/prismaBase.js';
import { logger } from '../infra/logger.js';
import type { QueueName } from './names.js';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

export type IdempotentResult = { alreadyProcessed: boolean };

export async function runIdempotently(
  queue: QueueName,
  idempotencyKey: string,
  effect: (tx: Prisma.TransactionClient) => Promise<void>,
  db: PrismaClient = prismaBase,
): Promise<IdempotentResult> {
  try {
    await db.$transaction(async (tx) => {
      // The INSERT is the claim. It has to happen before `effect` runs, not
      // after, or two concurrent deliveries of the same key could both pass
      // the check and both run the effect — the constraint only protects work
      // that happens after it succeeds.
      await tx.jobProcessingLog.create({ data: { queue, idempotencyKey } });
      await effect(tx);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.debug({ queue, idempotencyKey }, 'job already processed, skipping');
      return { alreadyProcessed: true };
    }
    throw error;
  }

  return { alreadyProcessed: false };
}
