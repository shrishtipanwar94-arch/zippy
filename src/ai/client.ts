// THE ONE PLACE THIS PROCESS TALKS TO A LANGUAGE MODEL.
//
// WHERE IT IS ALLOWED TO BE CALLED FROM: intake, and the chat classifier. Both
// are edges. Invariant 10 is absolute — the solver, the feasibility filter and
// the cost function may not depend on anything that leaves this machine, or the
// evaluation harness stops being reproducible. Nothing under src/engine imports
// this file, and nothing ever should.
//
// TWO KINDS OF FAILURE, TREATED DIFFERENTLY, because they mean different
// things:
//   UNAVAILABLE — no key, a refused connection, a 401, a 429, a 500, or a
//                 timeout. The service is not there. Retrying inside one
//                 driver's request just spends their time; we degrade.
//   INVALID     — a 200 whose body did not fit the schema. The service is
//                 there and got it wrong, which is worth exactly one more go
//                 (the phase brief says so, and a second attempt on a
//                 stochastic decoder is genuinely likely to differ).
// The caller (extractSymptoms.ts) implements that policy; this file only
// classifies.
//
// SDK RETRIES ARE OFF. The SDK would retry 429s and 5xxs twice by default,
// which on an 8-second budget means a driver watching a spinner for 24
// seconds before the picker appears. Failing fast into a working degraded path
// is the better trade here, and it is the one this whole codebase makes.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../infra/config.js';

export type LlmFailureKind = 'UNAVAILABLE' | 'INVALID_OUTPUT';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type LlmCallResult<T> = {
  value: T;
  model: string;
  latencyMs: number;
  // What the model actually returned, before validation. Stored on the
  // AiExtraction row so a bad extraction can be argued with after the fact
  // rather than guessed at.
  rawText: string;
};

// A model call, as the rest of the codebase sees it. Everything that calls the
// model goes through this type, which is what lets a test hand in a function
// instead of a network.
export type SchemaCall = <T>(
  schema: z.ZodType<T>,
  system: string,
  user: string,
) => Promise<LlmCallResult<T>>;

export function isLlmConfigured(): boolean {
  return Boolean(config.LLM_API_KEY);
}

// Built once and reused, so the underlying HTTP agent's connections are too.
// Null until the first call, and null forever when no key is set.
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.LLM_API_KEY) {
    throw new LlmError('UNAVAILABLE', 'no LLM_API_KEY is configured');
  }
  if (!client) {
    client = new Anthropic({
      apiKey: config.LLM_API_KEY,
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return client;
}

// SCHEMA-CONSTRAINED DECODING
// `output_config.format` hands the model a JSON schema and constrains its
// decoding to fit, and `messages.parse` runs the reply back through the same
// Zod schema, handing us `parsed_output`. When that comes back null the model
// produced something the schema rejected — an INVALID_OUTPUT, which the caller
// retries once.
export const callModel: SchemaCall = async (schema, system, user) => {
  const startedAt = Date.now();

  let response;
  try {
    response = await getClient().messages.parse({
      model: config.LLM_MODEL,
      max_tokens: 2000,
      // Low effort on purpose: this is form-filling from one short message, not
      // a problem that rewards deliberation, and every millisecond is a driver
      // standing next to a road.
      output_config: { effort: 'low', format: zodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError('UNAVAILABLE', describe(error));
  }

  const latencyMs = Date.now() - startedAt;
  const rawText = textOf(response.content);

  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new LlmError(
      'INVALID_OUTPUT',
      `model returned output the schema rejected (stop_reason=${response.stop_reason})`,
    );
  }

  return { value: response.parsed_output, model: response.model, latencyMs, rawText };
};

function textOf(content: Anthropic.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

function describe(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error calling the model';
}
