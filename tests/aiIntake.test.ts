// PHASE 16 — the AI at the edge of intake, and the four things that must stay
// true whatever the model does.
//
// 1. A schema-invalid reply is retried EXACTLY once, then the pipeline falls
//    back. Not twice, not forever — a driver is waiting.
// 2. An absent model is a working system. Every failure mode ends in the same
//    place the Phase 3 picker path ends.
// 3. The described path and the picker path produce IDENTICALLY SHAPED
//    hypotheses. That is the phase's whole claim, so it is asserted rather
//    than described.
// 4. The chat classifier only ever adds to the rule table, never replaces it.
//
// NO NETWORK AND NO API KEY. Every model call here is an injected function, so
// these run in the fast suite and every branch is reachable. The one thing
// they cannot check is that the real request shape is accepted by the real
// API — that needs a key, and is stated as untested in DECISIONS.log rather
// than implied to be covered.

import { describe, expect, it } from 'vitest';
import { extractSymptoms } from '../src/ai/extractSymptoms.js';
import { LlmError } from '../src/ai/client.js';
import type { SchemaCall } from '../src/ai/client.js';
import {
  signalsFromSafetyReport,
  toSafetyReport,
  toSymptomPayload,
} from '../src/ai/extraction.js';
import type { SymptomExtraction } from '../src/ai/extraction.js';
import { classifyMessageWithAi } from '../src/ai/classifyMessage.js';
import { buildHypothesisView, normaliseToOne } from '../src/domain/hypothesisView.js';
import { FAULT_CODES, FAULT_PRIORS } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';
import { symptomPayloadSchema } from '../src/domain/symptoms.js';
import { safetyReportSchema } from '../src/domain/safety.js';

const configured = () => true;

const ALTERNATOR_EXTRACTION: SymptomExtraction = {
  primaryComplaint: 'WONT_START',
  engineCranks: 'NO',
  warningLights: ['BATTERY'],
  unusualSound: 'CLICKING',
  vehicleMoves: 'NO',
  urgencySignals: ['BLOCKING_LIVE_LANE', 'DRIVER_ALONE'],
  vehicleContext: { make: 'Maruti', model: 'Swift', fuel: 'PETROL' },
  evidence: 'khatakhat awaaz, battery ka light',
};

// A call that returns whatever the queue says, in order. Each entry is either
// the value to resolve with or the error to throw.
function scriptedCall(script: Array<SymptomExtraction | LlmError>): {
  call: SchemaCall;
  callCount: () => number;
} {
  let index = 0;
  const call = (async () => {
    const step = script[index] ?? script[script.length - 1];
    index++;
    if (step instanceof LlmError) throw step;
    return { value: step, model: 'test-model', latencyMs: 12, rawText: JSON.stringify(step) };
  }) as SchemaCall;
  return { call, callCount: () => index };
}

describe('extraction retry policy', () => {
  it('extracts on the first valid reply and calls the model once', async () => {
    const { call, callCount } = scriptedCall([ALTERNATOR_EXTRACTION]);
    const outcome = await extractSymptoms('gaadi start nahi ho rahi', call, configured);

    expect(outcome.status).toBe('EXTRACTED');
    expect(callCount()).toBe(1);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]?.validated).toBe(true);
  });

  it('retries a schema-invalid reply exactly once, and succeeds on the second', async () => {
    const { call, callCount } = scriptedCall([
      new LlmError('INVALID_OUTPUT', 'not the schema'),
      ALTERNATOR_EXTRACTION,
    ]);
    const outcome = await extractSymptoms('battery light aa raha hai', call, configured);

    expect(outcome.status).toBe('EXTRACTED');
    expect(callCount()).toBe(2);
    expect(outcome.attempts.map((attempt) => attempt.validated)).toEqual([false, true]);
  });

  it('falls back after two schema-invalid replies and never makes a third call', async () => {
    const { call, callCount } = scriptedCall([new LlmError('INVALID_OUTPUT', 'nope')]);
    const outcome = await extractSymptoms('anything', call, configured);

    expect(outcome.status).toBe('FALLBACK');
    expect(callCount()).toBe(2);
    if (outcome.status === 'FALLBACK') expect(outcome.reason).toBe('INVALID_OUTPUT');
  });

  it('does not retry when the service is unavailable — one call, then the picker', async () => {
    const { call, callCount } = scriptedCall([new LlmError('UNAVAILABLE', 'connection refused')]);
    const outcome = await extractSymptoms('anything', call, configured);

    expect(outcome.status).toBe('FALLBACK');
    expect(callCount()).toBe(1);
    if (outcome.status === 'FALLBACK') expect(outcome.reason).toBe('UNAVAILABLE');
  });

  it('calls nothing at all when no key is configured', async () => {
    const { call, callCount } = scriptedCall([ALTERNATOR_EXTRACTION]);
    const outcome = await extractSymptoms('anything', call, () => false);

    expect(outcome.status).toBe('FALLBACK');
    expect(callCount()).toBe(0);
    if (outcome.status === 'FALLBACK') expect(outcome.reason).toBe('NOT_CONFIGURED');
  });
});

describe('the extracted form is the form intake already takes', () => {
  it('produces a payload the symptom schema accepts', () => {
    const payload = toSymptomPayload(ALTERNATOR_EXTRACTION);
    expect(() => symptomPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.engineCranks).toBe('NO');
    expect(payload.vehicleMoves).toBe(false);
  });

  it('maps NOT_STATED to null, which is not the same as UNSURE', () => {
    const payload = toSymptomPayload({
      ...ALTERNATOR_EXTRACTION,
      engineCranks: 'NOT_STATED',
      unusualSound: 'NOT_STATED',
      vehicleMoves: 'NOT_STATED',
    });

    expect(payload.engineCranks).toBeNull();
    expect(payload.unusualSound).toBeNull();
    expect(payload.vehicleMoves).toBeNull();
  });

  it('de-duplicates repeated warning lights so one report is not counted twice', () => {
    const payload = toSymptomPayload({
      ...ALTERNATOR_EXTRACTION,
      warningLights: ['BATTERY', 'BATTERY', 'ENGINE'],
    });
    expect(payload.warningLights).toEqual(['BATTERY', 'ENGINE']);
  });

  it('turns urgency signals into the safety form, and back again', () => {
    const safety = toSafetyReport(ALTERNATOR_EXTRACTION);
    expect(() => safetyReportSchema.parse(safety)).not.toThrow();
    expect(safety.blockingLiveLane).toBe(true);
    expect(safety.driverAlone).toBe(true);
    expect(safety.fuelSmell).toBe(false);

    expect(signalsFromSafetyReport(safety).sort()).toEqual(['BLOCKING_LIVE_LANE', 'DRIVER_ALONE']);
  });
});

describe('the hypothesis is the same shape whichever path filled the form', () => {
  it('the described path and the picker path produce identical keys', () => {
    const described = buildHypothesisView({
      symptoms: toSymptomPayload(ALTERNATOR_EXTRACTION),
      urgencySignals: ALTERNATOR_EXTRACTION.urgencySignals,
      vehicleContext: ALTERNATOR_EXTRACTION.vehicleContext,
    });
    const picked = buildHypothesisView({
      symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'WONT_START' }),
      urgencySignals: [],
      vehicleContext: null,
    });

    expect(Object.keys(described).sort()).toEqual(Object.keys(picked).sort());
    expect(described.rankedFaults.length).toBe(FAULT_CODES.length);
    expect(picked.vehicleContext).toBeNull();
  });

  it('always sums to one, and says so when it had to rescale', () => {
    const view = buildHypothesisView({
      symptoms: toSymptomPayload(ALTERNATOR_EXTRACTION),
      urgencySignals: [],
      vehicleContext: null,
    });

    const total = FAULT_CODES.reduce((sum, fault) => sum + view.faultDistribution[fault], 0);
    expect(total).toBeCloseTo(1, 9);
    expect(view.renormalised).toBe(false);

    const short = {} as FaultDistribution;
    for (const fault of FAULT_CODES) short[fault] = FAULT_PRIORS[fault] * 0.5;
    const fixedUp = normaliseToOne(short);
    expect(fixedUp.renormalised).toBe(true);
    expect(FAULT_CODES.reduce((sum, fault) => sum + fixedUp.distribution[fault], 0)).toBeCloseTo(1, 9);
  });

  it('reads a tow probability off the distribution rather than being told one', () => {
    const stuck = buildHypothesisView({
      symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'STUCK_OR_DAMAGED' }),
      urgencySignals: [],
      vehicleContext: null,
    });
    const tyre = buildHypothesisView({
      symptoms: symptomPayloadSchema.parse({ primaryComplaint: 'FLAT_TYRE' }),
      urgencySignals: [],
      vehicleContext: null,
    });

    expect(stuck.towProbability).toBeGreaterThan(tyre.towProbability);
  });
});

describe('the chat classifier adds to the rule table and never replaces it', () => {
  it('keeps the rule table findings when the model is unavailable', async () => {
    const failing = (async () => {
      throw new LlmError('UNAVAILABLE', 'no key');
    }) as SchemaCall;

    const result = await classifyMessageWithAi(
      "I'm on the service road, not the highway",
      failing,
      configured,
    );

    expect(result.modelUsed).toBe(false);
    expect(result.classifications.map((row) => row.kind)).toContain('LOCATION_CORRECTION');
  });

  it('adds a kind the phrase table cannot match, in Hindi', async () => {
    const call = (async () => ({
      value: {
        findings: [
          { kind: 'LOCATION_CORRECTION', evidence: ['service road pe hoon'], roadPosition: 'SERVICE_ROAD' },
        ],
      },
      model: 'test-model',
      latencyMs: 9,
      rawText: '{}',
    })) as unknown as SchemaCall;

    const result = await classifyMessageWithAi('main service road pe hoon bhai', call, configured);

    expect(result.modelUsed).toBe(true);
    const location = result.classifications.find((row) => row.kind === 'LOCATION_CORRECTION');
    expect(location?.proposedPayload.roadPosition).toBe('SERVICE_ROAD');
    expect(location?.matched).toContain('service road pe hoon');
  });

  it('keeps the rule table payload when both sides flag the same kind', async () => {
    const call = (async () => ({
      value: {
        findings: [
          { kind: 'LOCATION_CORRECTION', evidence: ['model evidence'], roadPosition: 'PARKING' },
        ],
      },
      model: 'test-model',
      latencyMs: 9,
      rawText: '{}',
    })) as unknown as SchemaCall;

    const result = await classifyMessageWithAi('I am on the service road', call, configured);
    const location = result.classifications.find((row) => row.kind === 'LOCATION_CORRECTION');

    // The rule table said SERVICE_ROAD from a phrase somebody wrote down. The
    // model's PARKING does not overwrite it; its evidence is appended.
    expect(location?.proposedPayload.roadPosition).toBe('SERVICE_ROAD');
    expect(location?.matched).toContain('model evidence');
  });
});
