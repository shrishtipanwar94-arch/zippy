// THE COMPLETION VERIFICATION CODE.
//
// The driver's phone shows a six-digit code. The technician types it in to
// close the job. That single exchange is the only evidence Zippy ever gets
// that the service was actually delivered to the person who asked for it —
// the technician's own "I'm done" is a claim, and the code is a confirmation
// from the other side of it.
//
// It also matters commercially: from Phase 15c, entering this code is what
// triggers the payment capture. That is why the code is generated ON ARRIVAL
// rather than at completion — the driver needs to have had it on screen for a
// while before anybody asks for it, and a code that appears at the same moment
// it is requested confirms nothing.
//
// IDEMPOTENT GENERATION. Arriving twice (a replayed offline action, a
// dispatcher re-sending) must not mint a second code, or the driver is reading
// out a number the technician's screen will reject. `completion_verifications`
// has a UNIQUE job_id, so the second insert loses and reads the existing row
// instead — the database is the arbiter rather than a read-then-write.

import { randomInt } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { isUniqueViolation } from '../infra/prismaErrors.js';

// Six digits, not four. It is read aloud once and typed once, so the extra two
// digits cost the driver nothing and take a blind guess from one in ten
// thousand to one in a million. There is no attempt rate limit — see the
// weaknesses section of this phase's DECISIONS.log entry.
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function ensureCompletionCode(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<string> {
  const existing = await tx.completionVerification.findUnique({
    where: { jobId },
    select: { code: true },
  });
  if (existing) return existing.code;

  const code = generateCode();
  try {
    await tx.completionVerification.create({
      data: { jobId, code, method: 'CODE' },
    });
    return code;
  } catch (error) {
    // Somebody else created it between the read and the write. Their code is
    // the one the driver is looking at, so it is the one that counts.
    if (!isUniqueViolation(error)) throw error;
    const raced = await tx.completionVerification.findUniqueOrThrow({
      where: { jobId },
      select: { code: true },
    });
    return raced.code;
  }
}

export type CodeCheck =
  | { outcome: 'VERIFIED' }
  | { outcome: 'WRONG_CODE' }
  // The technician reached completion without ever marking themselves on
  // scene, so no code was ever generated. Refused rather than waved through.
  | { outcome: 'NO_CODE_ISSUED' };

export async function verifyCompletionCode(
  tx: Prisma.TransactionClient,
  input: { jobId: string; code: string; verifierRole: string },
): Promise<CodeCheck> {
  const verification = await tx.completionVerification.findUnique({
    where: { jobId: input.jobId },
    select: { id: true, code: true },
  });
  if (!verification) return { outcome: 'NO_CODE_ISSUED' };

  const submitted = input.code.replace(/\s/g, '');
  if (submitted !== verification.code) return { outcome: 'WRONG_CODE' };

  await tx.completionVerification.update({
    where: { id: verification.id },
    data: { result: 'VERIFIED', verifierRole: input.verifierRole, verifiedAt: new Date() },
  });
  return { outcome: 'VERIFIED' };
}
