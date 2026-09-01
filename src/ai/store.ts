// EVERY EXTRACTION IS WRITTEN DOWN, including the ones that failed.
//
// WHY THE FAILURES MATTER MOST. schemaValidRate and fallbackRate are two of the
// six numbers this phase promises to report, and both are ratios whose
// denominator is "every time we asked". A table that only records successes
// makes both of them 100% and makes the report a lie by omission.
//
// WHAT GOES IN WHICH COLUMN
//   prompt      the driver's own words. NOT the system prompt — that is a
//               constant living in src/ai/prompt.ts and versioned by git, and
//               copying it onto every row would be several kilobytes of
//               duplication per breakdown.
//   rawResponse the attempts: latency, what came back, and why it failed.
//   extracted   the validated form, and the symptom payload it converts to.
//   confidence  the top fault's probability AFTER the rule table has run. The
//               model is never asked how confident it is — a self-reported
//               confidence is not a calibrated one, and the whole point of
//               measuring ECE is to have a number that can be checked.
//   accepted    whether the driver went ahead with what was extracted, set
//               later by linkExtractionToJob when the job is actually created.

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { ExtractionOutcome } from './extractSymptoms.js';
import type { SymptomPayload } from '../domain/symptoms.js';

export async function storeExtraction(
  db: PrismaClient,
  input: { rawText: string; outcome: ExtractionOutcome; confidence: number | null },
): Promise<string> {
  const { outcome } = input;

  const row = await db.aiExtraction.create({
    data: {
      model: outcome.status === 'EXTRACTED' ? outcome.model : 'none',
      prompt: input.rawText,
      rawResponse: {
        status: outcome.status,
        totalLatencyMs: outcome.totalLatencyMs,
        reason: outcome.status === 'FALLBACK' ? outcome.reason : null,
        attempts: outcome.attempts,
      },
      extracted:
        outcome.status === 'EXTRACTED'
          ? { extraction: outcome.extraction, symptoms: outcome.symptoms, safety: outcome.safety }
          : Prisma.JsonNull,
      confidence: input.confidence,
      accepted: null,
    },
    select: { id: true },
  });

  return row.id;
}

// THE DRIVER'S VERDICT. Called from inside the intake transaction with the
// symptoms the driver actually submitted, which may not be the ones that were
// extracted — the confirmation screen exists precisely so they can be changed.
//
// `accepted` is therefore "did the driver leave it alone", not "did the job get
// created". A correction rate is the honest measure of an extractor that a
// human checks, and it is the one number here no offline evaluation can
// produce.
//
// SCOPED TO AN UNCLAIMED ROW. The update matches only an extraction with no job
// yet, so replaying an intake with a stale extraction id cannot re-point a
// record at a second job.
export async function linkExtractionToJob(
  db: Prisma.TransactionClient,
  input: { extractionId: string; jobId: string; symptoms: SymptomPayload },
): Promise<void> {
  const row = await db.aiExtraction.findUnique({
    where: { id: input.extractionId },
    select: { id: true, jobId: true, extracted: true },
  });
  if (!row || row.jobId) return;

  const extracted = (row.extracted ?? {}) as { symptoms?: unknown };

  await db.aiExtraction.updateMany({
    where: { id: row.id, jobId: null },
    data: {
      jobId: input.jobId,
      accepted: sameSymptoms(extracted.symptoms, input.symptoms),
    },
  });
}

// Field by field rather than a JSON string compare, because key order in a
// stored blob is not something this code controls and two identical payloads
// serialised differently would read as a correction that never happened.
function sameSymptoms(stored: unknown, submitted: SymptomPayload): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const previous = stored as Partial<SymptomPayload>;

  return (
    previous.primaryComplaint === submitted.primaryComplaint &&
    (previous.engineCranks ?? null) === submitted.engineCranks &&
    (previous.unusualSound ?? null) === submitted.unusualSound &&
    (previous.vehicleMoves ?? null) === submitted.vehicleMoves &&
    sameLights(previous.warningLights, submitted.warningLights)
  );
}

function sameLights(stored: string[] | undefined, submitted: string[]): boolean {
  const before = [...(stored ?? [])].sort().join(',');
  const after = [...submitted].sort().join(',');
  return before === after;
}
