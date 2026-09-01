// THE BOUNDARY BETWEEN THIS CODEBASE AND WHATEVER MODEL IS ANSWERING.
//
// Everything upstream — the extractor, the chat classifier, the evaluation
// harness — depends on ONE type, `SchemaCall`: give it a Zod schema, a system
// prompt and a user message, get back a validated value or an `LlmError`.
// Which provider satisfies that is a configuration question answered here and
// nowhere else.
//
// WHY THERE ARE TWO PROVIDERS. The project was built against Anthropic's
// Messages API, whose `output_config.format` constrains decoding to a schema.
// It then had to run against Groq, which speaks the OpenAI-compatible
// chat-completions shape with `response_format: json_schema`. The two wire
// formats have nothing in common, so each gets its own file and this one
// picks. The alternative — one function with provider `if`s threaded through
// it — would put two protocols in one body and make both harder to read.
//
// WHERE THIS MAY BE CALLED FROM: intake, and the chat classifier. Both are
// edges. Invariant 10 is absolute — the solver, the feasibility filter and the
// cost function may not depend on anything that leaves this machine, or the
// evaluation harness stops being reproducible. Nothing under src/engine
// imports this file, and nothing ever should.
//
// TWO KINDS OF FAILURE, because they mean different things:
//   UNAVAILABLE     — no key, a refused connection, a 401, a 429, a 500, a
//                     timeout. The service is not there. Retrying inside one
//                     driver's request spends their time; we degrade.
//   INVALID_OUTPUT  — a 200 whose body did not fit the schema. The service is
//                     there and got it wrong, which is worth exactly one more
//                     go. src/ai/extractSymptoms.ts owns that policy.

import type { z } from 'zod';
import { config } from '../infra/config.js';
import { callAnthropic } from './providers/anthropic.js';
import { callOpenAiCompatible } from './providers/openAiCompatible.js';

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

// The one shape every caller depends on. A test hands in a function; the
// providers below hand in a network.
export type SchemaCall = <T>(
  schema: z.ZodType<T>,
  system: string,
  user: string,
) => Promise<LlmCallResult<T>>;

export function isLlmConfigured(): boolean {
  return Boolean(config.LLM_API_KEY);
}

export const callModel: SchemaCall = (schema, system, user) => {
  if (!config.LLM_API_KEY) {
    return Promise.reject(new LlmError('UNAVAILABLE', 'no LLM_API_KEY is configured'));
  }
  if (config.LLM_PROVIDER === 'openai-compatible') {
    return callOpenAiCompatible(schema, system, user);
  }
  return callAnthropic(schema, system, user);
};
