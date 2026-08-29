// RETRY AT THE TRANSACTION BOUNDARY, NOT THE STATEMENT
//
// Job events carry a per-job sequence number and the writer picks it by reading
// the current maximum and adding one. Two writers on the same job can read the
// same maximum; one of them then loses the (job_id, sequence) unique
// constraint. The tempting fix is to catch that and re-insert with the next
// number — but the failing INSERT happens inside a transaction, and Postgres
// marks a transaction aborted the moment any statement in it errors. Nothing
// can be re-tried inside it; the only legal next statement is ROLLBACK.
//
// So the retry lives out here, around the whole unit of work. The loser rolls
// back, reads the new maximum, and does its work again. The write set is small
// and idempotent-by-construction (nothing is read and carried forward across
// the retry), so replaying it is safe.

import type { Prisma, PrismaClient } from '@prisma/client';

// Contention on one job is rare — a job has one driver answering one question
// at a time. Three attempts covers a double-tap; exhausting it means the
// assumption is wrong and the caller should hear about it.
const MAX_ATTEMPTS = 3;

// Prisma closes an interactive transaction after 5 seconds by default. Intake
// makes about a dozen small round trips, so 5s is normally generous — but a
// cold connection or a busy laptop can blow through it, and losing a whole
// job because the machine hiccuped is not a failure worth having.
const TRANSACTION_TIMEOUT_MS = 20_000;

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

export async function runIntakeTransaction<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(work, { timeout: TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}
