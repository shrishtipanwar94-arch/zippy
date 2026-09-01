// THE OPENAI-COMPATIBLE PROVIDER — Groq, and anything else that speaks
// `POST /chat/completions`.
//
// WHY RAW `fetch` AND NOT AN SDK. This is one POST with a JSON body and one
// JSON reply. The Anthropic path earns its SDK because `messages.parse` does
// the schema plumbing for us; here the whole protocol fits on one screen, and
// a second SDK would be a dependency the maintainer would have to learn to
// read a request they can already read.
//
// STRUCTURED OUTPUT, THE OPENAI WAY. `response_format: { type: 'json_schema' }`
// with `strict: true` constrains decoding to the schema — the same idea as
// Anthropic's `output_config.format`, a different wire shape. The schema is
// generated from the same Zod object the reply is then validated against, so
// there is one definition of the form and no chance of the two drifting.
//
// WHAT `sanitiseSchema` IS FOR. Strict mode accepts a deliberately small
// subset of JSON Schema. Zod emits `$schema`, `maxLength` and `maxItems`,
// none of which that subset allows, and a schema carrying them is rejected
// with a 400 — which would degrade every driver to the picker for a reason
// that has nothing to do with the model. So the generated schema is walked
// once and the unsupported keywords are dropped. The LIMITS THEMSELVES ARE NOT
// LOST: Zod still enforces every one of them when the reply is validated
// below. The model simply is not told about them.

import { toJSONSchema } from 'zod';
import type { z } from 'zod';
import { config } from '../../infra/config.js';
import { LlmError } from '../client.js';
import type { SchemaCall } from '../client.js';

// Keywords strict structured-output mode does not accept. Dropped from the
// schema sent to the model; still enforced by Zod on the way back.
const UNSUPPORTED_KEYWORDS = ['$schema', 'maxLength', 'minLength', 'maxItems', 'minItems', 'format', 'pattern'];

export const callOpenAiCompatible: SchemaCall = async (schema, system, user) => {
  const startedAt = Date.now();
  const body = {
    model: config.LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Zero, not the default. This is form-filling from one short message: the
    // same sentence should produce the same form twice, and creativity here is
    // a defect rather than a feature.
    temperature: 0,
    max_completion_tokens: 2000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: sanitiseSchema(schema) },
    },
  };

  let response: Response;
  try {
    response = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      // The provider gets the same budget the Anthropic path gets, for the
      // same reason: a driver is waiting on this.
      signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
    });
  } catch (error) {
    // A refused connection, a DNS failure or the timeout above.
    throw new LlmError('UNAVAILABLE', describe(error));
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw new LlmError('UNAVAILABLE', `HTTP ${response.status}: ${rawText.slice(0, 300)}`);
  }

  const latencyMs = Date.now() - startedAt;
  return { value: parseOpenAiReply(schema, rawText), model: config.LLM_MODEL, latencyMs, rawText };
};

// From the provider's envelope to a validated value. Everything that can go
// wrong from here is INVALID_OUTPUT: the service answered, and what it said
// did not fit. Exported because this is the branch that decides between one
// more attempt and the symptom picker, and it is worth a test that does not
// need a network.
export function parseOpenAiReply<T>(schema: z.ZodType<T>, rawText: string): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawText);
  } catch {
    throw new LlmError('INVALID_OUTPUT', 'the provider did not return JSON');
  }

  const choice = (envelope as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> })
    .choices?.[0];
  if (choice?.message?.refusal) {
    throw new LlmError('INVALID_OUTPUT', `the model declined: ${String(choice.message.refusal).slice(0, 200)}`);
  }

  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new LlmError('INVALID_OUTPUT', 'the reply carried no message content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LlmError('INVALID_OUTPUT', 'the message content was not JSON');
  }

  // THE VALIDATION THAT MAKES schemaValidRate A MEASUREMENT. `strict: true`
  // is the provider's promise; this is the check. They are not the same thing,
  // and the evaluation reports the check.
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new LlmError('INVALID_OUTPUT', result.error.issues.map((issue) => issue.message).join('; ').slice(0, 300));
  }
  return result.data;
}

// The Zod schema as JSON Schema, with the keywords strict mode rejects removed
// at every level. Recursive because the form has a nested object and arrays,
// and a `maxItems` buried two levels down fails the request just as hard as
// one at the top.
export function sanitiseSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return strip(toJSONSchema(schema)) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    cleaned[key] = strip(value);
  }
  return cleaned;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error calling the model';
}
