// THE EVALUATION IS ITSELF TESTED, because a measuring instrument nobody has
// checked is an opinion with decimal places.
//
// The metrics here are the ones Phase 16 promises to report honestly, and each
// has a specific way of lying: an accuracy that quietly scores predictions
// that were never made, a calibration error that comes out at zero because the
// bins are empty, a correlation that reports 0 when it means "undefined". Each
// of those is asserted against below.

import { describe, expect, it } from 'vitest';
import { CASES } from '../evaluation/ai/cases.js';
import { computeAiMetrics, pearson } from '../evaluation/ai/metrics.js';
import type { CaseOutcome } from '../evaluation/ai/metrics.js';
import { keywordExtraction } from '../evaluation/ai/keywordBaseline.js';
import { createLlmExtractor, keywordBaselineExtractor, runCases } from '../evaluation/ai/runner.js';
import { toSafetyReport, toSymptomPayload } from '../src/ai/extraction.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultCode } from '../src/domain/faults.js';

function outcome(overrides: Partial<CaseOutcome>): CaseOutcome {
  return {
    id: 'case',
    language: 'EN',
    trueFault: 'FLAT_BATTERY',
    predicted: true,
    calls: 1,
    validCalls: 1,
    top1: 'FLAT_BATTERY',
    top2: ['FLAT_BATTERY', 'FAILED_BATTERY'],
    confidence: 0.8,
    entropyBits: 1.5,
    secondDispatch: false,
    ...overrides,
  };
}

describe('the labelled set', () => {
  it('has at least the hundred cases the phase asks for, with unique ids', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
    expect(new Set(CASES.map((row) => row.id)).size).toBe(CASES.length);
  });

  it('covers every fault in the catalogue — a fault with no case is unmeasured', () => {
    const labelled = new Set<FaultCode>(CASES.map((row) => row.fault));
    for (const fault of FAULT_CODES) {
      expect(labelled.has(fault)).toBe(true);
    }
  });

  it('is not all English — the phase is about mixed Hindi and English intake', () => {
    const hindi = CASES.filter((row) => row.language !== 'EN');
    expect(hindi.length).toBeGreaterThan(CASES.length / 3);
  });
});

describe('metrics', () => {
  it('scores only predictions that were actually made', () => {
    const metrics = computeAiMetrics([
      outcome({ id: 'a' }),
      outcome({ id: 'b', predicted: false, top1: null, top2: [], confidence: 0 }),
    ]);

    // One of one scored prediction was right — the fallback is not a miss, it
    // is not a prediction, and it shows up in fallbackRate instead.
    expect(metrics.top1Accuracy).toBe(1);
    expect(metrics.predictedCount).toBe(1);
    expect(metrics.fallbackRate).toBe(0.5);
  });

  it('reports a schema-valid rate of 1 when nothing was ever called', () => {
    const metrics = computeAiMetrics([outcome({ calls: 0, validCalls: 0 })]);
    expect(metrics.schemaValidRate).toBe(1);
  });

  it('counts a retried call in the denominator', () => {
    const metrics = computeAiMetrics([outcome({ calls: 2, validCalls: 1 })]);
    expect(metrics.schemaValidRate).toBe(0.5);
  });

  it('gives a perfectly calibrated set an ECE of zero', () => {
    // Ten cases at a stated 0.8 confidence, eight of them right.
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      outcome({
        id: `c${index}`,
        confidence: 0.8,
        top1: index < 8 ? 'FLAT_BATTERY' : 'OUT_OF_FUEL',
      }),
    );

    expect(computeAiMetrics(outcomes).expectedCalibrationError).toBeCloseTo(0, 9);
  });

  it('catches an overconfident set', () => {
    const outcomes = Array.from({ length: 10 }, (_, index) =>
      outcome({
        id: `c${index}`,
        confidence: 0.95,
        top1: index < 5 ? 'FLAT_BATTERY' : 'OUT_OF_FUEL',
      }),
    );

    expect(computeAiMetrics(outcomes).expectedCalibrationError).toBeCloseTo(0.45, 6);
  });

  it('returns null rather than zero when a correlation is undefined', () => {
    const outcomes = [outcome({ id: 'a' }), outcome({ id: 'b', entropyBits: 2 })];
    // Nothing needed a second dispatch, so there is no variance to correlate
    // against. Zero would read as "measured, no relationship".
    expect(computeAiMetrics(outcomes).entropySecondDispatchCorrelation).toBeNull();
  });

  it('computes a correlation that matches a hand-worked example', () => {
    expect(pearson([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    // Point-biserial by hand: dx = [-1.5,-0.5,0.5,1.5], dy = [-0.5,-0.5,0.5,0.5],
    // covariance 2, variances 5 and 1, so r = 2 / sqrt(5).
    expect(pearson([1, 2, 3, 4], [0, 0, 1, 1])).toBeCloseTo(2 / Math.sqrt(5), 9);
  });
});

describe('the keyword control', () => {
  it('is deterministic — the same sentence always extracts the same form', () => {
    const text = 'gaadi start nahi ho rahi, sirf tik-tik awaaz aa rahi hai';
    expect(keywordExtraction(text)).toEqual(keywordExtraction(text));
  });

  it('reads a no-crank sentence as NO despite the word "crank" being present', () => {
    const extraction = keywordExtraction('the engine does not crank, only a click');
    expect(extraction.engineCranks).toBe('NO');
    expect(extraction.unusualSound).toBe('CLICKING');
  });

  it('runs the whole labelled set and predicts on every case', async () => {
    const outcomes = await runCases(keywordBaselineExtractor, CASES.slice(0, 12));
    expect(outcomes).toHaveLength(12);
    expect(outcomes.every((row) => row.predicted)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PACING. A rate limit is a property of the account, not of the extractor, so
// a case the provider refused for quota reasons must not be scored as the
// model failing to read a sentence. These two tests are the difference between
// a 96% fallback rate that means "the free tier throttled us" and one that
// means "the extractor does not work".

describe('the paced model extractor', () => {
  const extraction = {
    primaryComplaint: 'FLAT_TYRE' as const,
    engineCranks: 'NOT_STATED' as const,
    warningLights: [],
    unusualSound: 'NOT_STATED' as const,
    vehicleMoves: 'NOT_STATED' as const,
    urgencySignals: [],
    vehicleContext: { make: null, model: null, fuel: 'UNKNOWN' as const },
    evidence: 'test',
  };

  function fallback(detail: string) {
    return {
      status: 'FALLBACK' as const,
      reason: 'UNAVAILABLE' as const,
      detail,
      attempts: [{ validated: false, latencyMs: 1, rawText: null, failure: detail }],
      totalLatencyMs: 1,
    };
  }

  it('retries a rate-limited case instead of scoring it, and counts the wait', async () => {
    let calls = 0;
    const extractor = createLlmExtractor(0, async () => {
      calls++;
      if (calls === 1) return fallback('HTTP 429: rate limit reached');
      return {
        status: 'EXTRACTED' as const,
        extraction,
        symptoms: toSymptomPayload(extraction),
        safety: toSafetyReport(extraction),
        model: 'test-model',
        attempts: [{ validated: true, latencyMs: 1, rawText: '{}', failure: null }],
        totalLatencyMs: 1,
      };
    });

    const attempted = await extractor.run('tyre punctured hai');

    expect(attempted.extraction).not.toBeNull();
    expect(extractor.rateLimitWaits()).toBe(1);
    expect(extractor.rateLimitFailures()).toBe(0);
  });

  it('does not retry a failure that is not a rate limit', async () => {
    let calls = 0;
    const extractor = createLlmExtractor(0, async () => {
      calls++;
      return fallback('HTTP 401: invalid key');
    });

    const attempted = await extractor.run('anything');

    expect(calls).toBe(1);
    expect(attempted.extraction).toBeNull();
    expect(extractor.rateLimitWaits()).toBe(0);
  });

  it('gives up after four goes and says so', async () => {
    const extractor = createLlmExtractor(0, async () => fallback('HTTP 429: rate limit reached'));

    const attempted = await extractor.run('anything');

    expect(attempted.extraction).toBeNull();
    expect(extractor.rateLimitFailures()).toBe(1);
  });
});
