// THE SECOND PROVIDER — Groq's OpenAI-compatible chat completions.
//
// Two things are worth a test here and the rest is wire format:
//
// 1. THE SCHEMA SENT TO THE MODEL. Strict structured-output mode rejects most
//    of JSON Schema, and Zod emits three keywords it will not take. A schema
//    carrying them comes back 400, which degrades every driver to the picker
//    for a reason that has nothing to do with the model — the worst kind of
//    outage, because it looks like a working fallback.
// 2. WHICH FAILURES ARE WORTH RETRYING. `parseOpenAiReply` is the branch that
//    decides between one more attempt and the symptom picker, and it must call
//    a bad body INVALID_OUTPUT rather than UNAVAILABLE.
//
// No network. The parser takes the raw response text, which is exactly what a
// test can hand it.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseOpenAiReply, sanitiseSchema } from '../src/ai/providers/openAiCompatible.js';
import { LlmError } from '../src/ai/client.js';
import { symptomExtractionSchema } from '../src/ai/extraction.js';

const smallSchema = z.object({ name: z.string(), count: z.number() });

function reply(content: unknown): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

describe('the schema handed to the model', () => {
  it('drops the keywords strict mode rejects, at every level', () => {
    const json = JSON.stringify(sanitiseSchema(symptomExtractionSchema));

    // The real schema has a maxLength on a nested string and a maxItems on an
    // array — one level down from the root, which is where a shallow strip
    // would miss them.
    expect(json).not.toContain('maxLength');
    expect(json).not.toContain('maxItems');
    expect(json).not.toContain('$schema');
  });

  it('keeps what strict mode requires', () => {
    const schema = sanitiseSchema(symptomExtractionSchema) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[] }>;
    };

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('primaryComplaint');
    expect(schema.properties.primaryComplaint?.enum).toContain('WONT_START');
  });
});

describe('reading the reply', () => {
  it('returns the validated value', () => {
    expect(parseOpenAiReply(smallSchema, reply({ name: 'a', count: 2 }))).toEqual({
      name: 'a',
      count: 2,
    });
  });

  it('calls a schema-invalid body INVALID_OUTPUT, so it is retried once', () => {
    try {
      parseOpenAiReply(smallSchema, reply({ name: 'a', count: 'two' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).kind).toBe('INVALID_OUTPUT');
    }
  });

  it('treats a refusal as a bad body rather than an outage', () => {
    const refused = JSON.stringify({ choices: [{ message: { refusal: 'I cannot help with that' } }] });
    try {
      parseOpenAiReply(smallSchema, refused);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LlmError).kind).toBe('INVALID_OUTPUT');
      expect((error as LlmError).message).toContain('declined');
    }
  });

  it('does not crash on an envelope with no content', () => {
    for (const body of ['not json at all', '{}', JSON.stringify({ choices: [] })]) {
      expect(() => parseOpenAiReply(smallSchema, body)).toThrowError(LlmError);
    }
  });
});
