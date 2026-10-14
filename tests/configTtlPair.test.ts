// THE ONE CONFIG RULE THAT IS ABOUT A PAIR RATHER THAN A FIELD.
//
// An offer that outlives its hold is the worst shape the reservation's two
// clocks can take: the technician's phone shows a live countdown, they press
// Accept, and `consumeHold` fails because the van was already released by the
// cleanup sweep. There is nothing to retry — the accept just loses, and the
// driver waits while a dispatcher works out why.
//
// So config.ts refuses to start on that pair. This file pins both halves of
// that: the arithmetic, and the fact that the schema actually applies it.
//
// WHY `ttlPairProblem` IS EXPORTED AND TESTED DIRECTLY. `loadConfig` calls
// `process.exit(1)` on a bad environment, which a test cannot catch — so the
// rule lives in a plain function over two numbers, and the schema calls it.
// Testing the function alone would prove the arithmetic and not the wiring, so
// the second describe parses a real environment through the real schema.

import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ROUND_TRIP_MARGIN_MS,
  config,
  envSchema,
  ttlPairProblem,
} from '../src/infra/config.js';

describe('ttlPairProblem — the hold has to outlive the offer', () => {
  it('accepts a hold longer than the offer plus the margin', () => {
    expect(ttlPairProblem(45_000, 120_000)).toBeNull();
  });

  it('accepts a hold exactly at the boundary', () => {
    expect(ttlPairProblem(45_000, 45_000 + ACCEPT_ROUND_TRIP_MARGIN_MS)).toBeNull();
  });

  it('rejects a hold one millisecond under the boundary', () => {
    const problem = ttlPairProblem(45_000, 45_000 + ACCEPT_ROUND_TRIP_MARGIN_MS - 1);
    expect(problem).not.toBeNull();
    expect(problem).toContain('HOLD_TTL_MS');
    expect(problem).toContain('OFFER_TTL_MS');
  });

  // The case somebody actually hits: lengthening the offer for a demo and
  // forgetting the hold. Five minutes of countdown over a two-minute hold.
  it('rejects a demo-length offer left against the default hold', () => {
    expect(ttlPairProblem(300_000, 120_000)).not.toBeNull();
  });

  it('rejects an equal pair, because the accept needs time to land', () => {
    expect(ttlPairProblem(60_000, 60_000)).not.toBeNull();
  });

  // The message is what somebody reads at 9am when the process will not start,
  // so it has to say what to change rather than only that something is wrong.
  it('explains the consequence, not just the rule', () => {
    const problem = ttlPairProblem(300_000, 120_000);
    expect(problem).toContain('300000');
    expect(problem).toContain('120000');
    expect(problem?.toLowerCase()).toContain('released');
  });
});

describe('envSchema — the rule is actually wired into startup', () => {
  // The suite's own environment is a valid one, so it is the honest base to
  // perturb: every other required variable is already set correctly and only
  // the pair under test changes.
  const validEnvironment = { ...process.env };

  it('parses the environment this suite runs in', () => {
    expect(envSchema.safeParse(validEnvironment).success).toBe(true);
  });

  it('refuses an offer that outlives its hold', () => {
    const parsed = envSchema.safeParse({
      ...validEnvironment,
      OFFER_TTL_MS: '300000',
      HOLD_TTL_MS: '120000',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    // Reported against HOLD_TTL_MS, because that is the field to raise.
    const issue = parsed.error.issues.find((candidate) => candidate.path.includes('HOLD_TTL_MS'));
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('must be at least');
  });

  it('accepts a demo pair that keeps the hold ahead of the offer', () => {
    const parsed = envSchema.safeParse({
      ...validEnvironment,
      OFFER_TTL_MS: '180000',
      HOLD_TTL_MS: '300000',
    });
    expect(parsed.success).toBe(true);
  });

  // Guards the defaults themselves. If somebody edits one of the two numbers in
  // config.ts without the other, this fails before anything reaches a demo.
  it('ships a pair that satisfies its own rule', () => {
    expect(ttlPairProblem(config.OFFER_TTL_MS, config.HOLD_TTL_MS)).toBeNull();
  });

  it('ships the documented defaults', () => {
    expect(config.OFFER_TTL_MS).toBe(45_000);
    expect(config.HOLD_TTL_MS).toBe(120_000);
  });
});
