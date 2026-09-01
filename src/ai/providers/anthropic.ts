// THE ANTHROPIC PROVIDER — the Messages API, with schema-constrained decoding.
//
// `output_config.format` hands the model a JSON schema and constrains its
// decoding to fit; `messages.parse` runs the reply back through the same Zod
// schema and hands us `parsed_output`. When that comes back null the model
// produced something the schema rejected — an INVALID_OUTPUT, which
// src/ai/extractSymptoms.ts retries once.
//
// SDK RETRIES ARE OFF. The SDK would retry 429s and 5xxs twice by default,
// which on an 8-second budget means a driver watching a spinner for 24 seconds
// before the picker appears. Failing fast into a working degraded path is the
// better trade here, and it is the one this whole codebase makes.
//
// The shared types and the provider choice live in src/ai/client.ts.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../../infra/config.js';
import { LlmError } from '../client.js';
import type { SchemaCall } from '../client.js';

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

export const callAnthropic: SchemaCall = async (schema, system, user) => {
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
