// ONE CASE THROUGH THE REAL PIPELINE, 108 times.
//
// WHAT IS REAL HERE AND WHAT IS NOT. The extraction is real — with a key, this
// makes 108 model calls through the same src/ai/extractSymptoms.ts an intake
// request uses, retry policy and all. Everything after it is real too: the
// same rule table, the same capability set, the same entropy. What is
// simulated is the OUTCOME — whether a technician sent with those capabilities
// would have fixed it is computed from the label rather than observed, and
// that is the proxy the report keeps saying it is.
//
// NO DATABASE. This harness writes nothing and reads nothing: it is the same
// contract as the Phase 10 dispatch harness, a pure function of a fixed input
// set, so two runs of the same extractor on the same cases with the model
// disabled produce identical output.

import { keywordExtraction } from './keywordBaseline.js';
import { CASES } from './cases.js';
import type { LabelledCase } from './cases.js';
import type { CaseOutcome } from './metrics.js';
import { extractSymptoms } from '../../src/ai/extractSymptoms.js';
import { toSymptomPayload } from '../../src/ai/extraction.js';
import type { SymptomExtraction } from '../../src/ai/extraction.js';
import { buildHypothesisView } from '../../src/domain/hypothesisView.js';
import { capabilitiesForFault } from '../../src/domain/faults.js';
import type { FaultCode } from '../../src/domain/faults.js';

export type ExtractorName = 'keyword-baseline' | 'llm';

type Attempted = {
  extraction: SymptomExtraction | null;
  calls: number;
  validCalls: number;
};

export type Extractor = {
  name: ExtractorName;
  run(text: string): Promise<Attempted>;
};

export const keywordBaselineExtractor: Extractor = {
  name: 'keyword-baseline',
  run: async (text) => ({ extraction: keywordExtraction(text), calls: 0, validCalls: 0 }),
};

export const llmExtractor: Extractor = {
  name: 'llm',
  run: async (text) => {
    const outcome = await extractSymptoms(text);
    return {
      extraction: outcome.status === 'EXTRACTED' ? outcome.extraction : null,
      calls: outcome.attempts.length,
      validCalls: outcome.attempts.filter((attempt) => attempt.validated).length,
    };
  },
};

export async function runCases(extractor: Extractor, cases = CASES): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  // Sequential on purpose. Firing 108 concurrent calls at a rate limit would
  // turn a measurement of the extractor into a measurement of the retry
  // policy, and the harness is not in a hurry.
  for (const labelled of cases) {
    outcomes.push(await runCase(extractor, labelled));
  }
  return outcomes;
}

async function runCase(extractor: Extractor, labelled: LabelledCase): Promise<CaseOutcome> {
  const attempted = await extractor.run(labelled.text);

  if (!attempted.extraction) {
    return {
      id: labelled.id,
      language: labelled.language,
      trueFault: labelled.fault,
      predicted: false,
      calls: attempted.calls,
      validCalls: attempted.validCalls,
      top1: null,
      top2: [],
      confidence: 0,
      entropyBits: 0,
      secondDispatch: false,
    };
  }

  const hypothesis = buildHypothesisView({
    symptoms: toSymptomPayload(attempted.extraction),
    urgencySignals: attempted.extraction.urgencySignals,
    vehicleContext: attempted.extraction.vehicleContext,
  });

  return {
    id: labelled.id,
    language: labelled.language,
    trueFault: labelled.fault,
    predicted: true,
    calls: attempted.calls,
    validCalls: attempted.validCalls,
    top1: hypothesis.topFault,
    top2: hypothesis.rankedFaults.slice(0, 2),
    confidence: hypothesis.faultDistribution[hypothesis.topFault],
    entropyBits: hypothesis.entropyBits,
    secondDispatch: !covers(hypothesis.requiredCapabilities, labelled.fault),
  };
}

// Would the crew we would have sent have been able to do the work? The
// capability set is a requirement — every capability the true fault needs has
// to be in it, not just one of them.
function covers(dispatched: string[], trueFault: FaultCode): boolean {
  return capabilitiesForFault(trueFault).every((capability) => dispatched.includes(capability));
}
