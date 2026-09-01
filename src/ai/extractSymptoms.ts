// FREE TEXT IN, A FILLED-IN INTAKE FORM OUT — or an honest failure.
//
// THE POLICY THIS FILE IMPLEMENTS, and it is the whole file:
//   no key configured        -> FALLBACK immediately, nothing is called
//   call failed              -> FALLBACK, no retry (the service is not there)
//   schema-invalid output    -> ONE more attempt, then FALLBACK
//   valid output             -> the symptom payload and the safety form
//
// FALLBACK IS NOT AN ERROR PATH, it is the Phase 3 path. The driver gets the
// structured symptom picker they had before any of this existed, the job is
// created identically, and the only difference is a banner saying so
// (invariant 8). Nothing here can fail in a way that stops a stranded driver
// getting a technician — that is the point of putting the AI at the edge.
//
// NO DATABASE, NO CLOCK BEYOND A STOPWATCH. The caller persists the attempt
// and moves the health state; this function is a pure-ish orchestration over
// an injected call, which is what lets the tests drive every branch above
// without a network.

import { callModel, isLlmConfigured, LlmError } from './client.js';
import type { SchemaCall } from './client.js';
import { symptomExtractionSchema, toSafetyReport, toSymptomPayload } from './extraction.js';
import type { SymptomExtraction } from './extraction.js';
import { EXTRACTION_SYSTEM_PROMPT, extractionUserMessage } from './prompt.js';
import type { SymptomPayload } from '../domain/symptoms.js';
import type { SafetyReport } from '../domain/safety.js';

export type FallbackReason = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INVALID_OUTPUT';

// One attempt at the model, recorded whether it worked or not. The evaluation
// harness counts these — schemaValidRate is exactly "how many of these have
// validated true".
export type ExtractionAttempt = {
  validated: boolean;
  latencyMs: number;
  rawText: string | null;
  failure: string | null;
};

export type ExtractionOutcome =
  | {
      status: 'EXTRACTED';
      extraction: SymptomExtraction;
      symptoms: SymptomPayload;
      safety: SafetyReport;
      model: string;
      attempts: ExtractionAttempt[];
      totalLatencyMs: number;
    }
  | {
      status: 'FALLBACK';
      reason: FallbackReason;
      detail: string;
      attempts: ExtractionAttempt[];
      totalLatencyMs: number;
    };

// Two, and the brief is explicit about the number: the first attempt, and one
// retry when the reply did not fit the schema.
const MAX_ATTEMPTS = 2;

// `call` and `configured` are parameters rather than imports used directly so
// that a test can drive every branch above — a valid reply, a schema-invalid
// one, a retry that succeeds, a service that is not there — without a network
// and without an API key. Both default to the real thing.
export async function extractSymptoms(
  text: string,
  call: SchemaCall = callModel,
  configured: () => boolean = isLlmConfigured,
): Promise<ExtractionOutcome> {
  const attempts: ExtractionAttempt[] = [];
  const startedAt = Date.now();

  if (!configured()) {
    return {
      status: 'FALLBACK',
      reason: 'NOT_CONFIGURED',
      detail: 'no LLM_API_KEY is configured',
      attempts,
      totalLatencyMs: 0,
    };
  }

  let lastFailure = new LlmError('UNAVAILABLE', 'the model was never called');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const result = await call(
        symptomExtractionSchema,
        EXTRACTION_SYSTEM_PROMPT,
        extractionUserMessage(text),
      );
      attempts.push({
        validated: true,
        latencyMs: result.latencyMs,
        rawText: result.rawText,
        failure: null,
      });
      return {
        status: 'EXTRACTED',
        extraction: result.value,
        symptoms: toSymptomPayload(result.value),
        safety: toSafetyReport(result.value),
        model: result.model,
        attempts,
        totalLatencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failure = error instanceof LlmError ? error : new LlmError('UNAVAILABLE', String(error));
      lastFailure = failure;
      attempts.push({
        validated: false,
        latencyMs: Date.now() - attemptStartedAt,
        rawText: null,
        failure: `${failure.kind}: ${failure.message}`,
      });
      // The service being absent is not something a second call fixes. Only a
      // bad body is worth asking again for.
      if (failure.kind !== 'INVALID_OUTPUT') break;
    }
  }

  return {
    status: 'FALLBACK',
    reason: lastFailure.kind === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'UNAVAILABLE',
    detail: lastFailure.message,
    attempts,
    totalLatencyMs: Date.now() - startedAt,
  };
}
