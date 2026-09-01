// THE SIX NUMBERS, and what each one is allowed to claim.
//
// top1Accuracy      the top fault was the labelled one.
// top2Recall        the labelled fault was in the top two. The gap between
//                   this and top1 is the size of the genuinely ambiguous
//                   middle — a flat battery and a failed battery over a phone.
// expectedCalibrationError (ECE)
//                   does a 0.7 mean 70%? Confidences are bucketed into ten
//                   bins and each bin's stated confidence is compared with how
//                   often it was actually right; ECE is the average gap,
//                   weighted by how many cases fell in each bin. A pipeline
//                   that is right 60% of the time while saying 0.9 has a real
//                   problem that top1Accuracy alone will never show.
// schemaValidRate   how often a model reply fitted the schema first time.
// fallbackRate      how often the whole pipeline gave up and the driver would
//                   have been handed the symptom picker.
// entropySecondDispatchCorrelation
//                   THE ONE THAT CAN INVALIDATE A DESIGN DECISION. See below.
//
// ENTROPY AND SECOND DISPATCHES. The cost function hedges on uncertainty: a
// high-entropy hypothesis widens the capability set (src/domain/
// capabilitySet.ts) so that a wrong guess still sends someone who can cope.
// That policy is only justified if uncertainty actually predicts a wasted
// visit. This correlates the entropy of each hypothesis against whether the
// dispatched capability set would have covered the true fault. If it comes out
// at or below zero, the hedging is unjustified BY THIS DATA and the report
// says exactly that.
//
// THE SECOND-DISPATCH PROXY IS A PROXY and the report repeats it: it is
// "would the capability set we would have sent have covered the true fault",
// computed from a label, not an observed second callout. It cannot see a
// technician who arrived with the right skill and the wrong part.

import type { FaultCode } from '../../src/domain/faults.js';

export type CaseOutcome = {
  id: string;
  language: string;
  trueFault: FaultCode;
  // False when the pipeline produced nothing — no key, a failure, or two
  // schema-invalid replies. Excluded from every accuracy figure and counted in
  // fallbackRate, because scoring a prediction that was never made would be
  // the most flattering possible mistake.
  predicted: boolean;
  // How many model calls were made, and how many of them validated. Both zero
  // for the keyword baseline, which never calls anything.
  calls: number;
  validCalls: number;
  top1: FaultCode | null;
  top2: FaultCode[];
  confidence: number;
  entropyBits: number;
  // The proxy above: true when the capability set implied by the prediction
  // would NOT have covered what was actually wrong.
  secondDispatch: boolean;
};

export type AiMetrics = {
  caseCount: number;
  predictedCount: number;
  top1Accuracy: number;
  top2Recall: number;
  expectedCalibrationError: number;
  schemaValidRate: number;
  fallbackRate: number;
  meanEntropyBits: number;
  secondDispatchRate: number;
  // Null when every case scored the same second-dispatch outcome: a
  // correlation with a constant is undefined, and reporting 0 would read as
  // "measured, no relationship" rather than "not measurable here".
  entropySecondDispatchCorrelation: number | null;
  calibrationBins: CalibrationBin[];
};

export type CalibrationBin = {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
};

const BIN_COUNT = 10;

export function computeAiMetrics(outcomes: CaseOutcome[]): AiMetrics {
  const predicted = outcomes.filter((outcome) => outcome.predicted);
  const calls = outcomes.reduce((total, outcome) => total + outcome.calls, 0);
  const validCalls = outcomes.reduce((total, outcome) => total + outcome.validCalls, 0);

  const correct = predicted.filter((outcome) => outcome.top1 === outcome.trueFault);
  const inTopTwo = predicted.filter((outcome) => outcome.top2.includes(outcome.trueFault));
  const bins = calibrationBins(predicted);

  return {
    caseCount: outcomes.length,
    predictedCount: predicted.length,
    top1Accuracy: ratio(correct.length, predicted.length),
    top2Recall: ratio(inTopTwo.length, predicted.length),
    expectedCalibrationError: expectedCalibrationError(bins, predicted.length),
    // No calls at all is not a 0% valid rate — it is "the question does not
    // apply", which for the keyword baseline is the truth.
    schemaValidRate: calls === 0 ? 1 : ratio(validCalls, calls),
    fallbackRate: ratio(outcomes.length - predicted.length, outcomes.length),
    meanEntropyBits: mean(predicted.map((outcome) => outcome.entropyBits)),
    secondDispatchRate: ratio(
      predicted.filter((outcome) => outcome.secondDispatch).length,
      predicted.length,
    ),
    entropySecondDispatchCorrelation: pearson(
      predicted.map((outcome) => outcome.entropyBits),
      predicted.map((outcome) => (outcome.secondDispatch ? 1 : 0)),
    ),
    calibrationBins: bins,
  };
}

function calibrationBins(outcomes: CaseOutcome[]): CalibrationBin[] {
  const bins: CalibrationBin[] = [];

  for (let index = 0; index < BIN_COUNT; index++) {
    const lower = index / BIN_COUNT;
    const upper = (index + 1) / BIN_COUNT;
    // The top bin owns its upper edge so a confidence of exactly 1 lands
    // somewhere rather than being dropped.
    const inBin = outcomes.filter((outcome) => {
      const value = outcome.confidence;
      return index === BIN_COUNT - 1 ? value >= lower && value <= upper : value >= lower && value < upper;
    });

    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanConfidence: mean(inBin.map((outcome) => outcome.confidence)),
      accuracy: ratio(inBin.filter((outcome) => outcome.top1 === outcome.trueFault).length, inBin.length),
    });
  }

  return bins;
}

function expectedCalibrationError(bins: CalibrationBin[], total: number): number {
  if (total === 0) return 0;
  let error = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    error += (bin.count / total) * Math.abs(bin.accuracy - bin.meanConfidence);
  }
  return error;
}

// Point-biserial correlation is just Pearson's with one binary variable, so
// there is one function rather than two and no special case to explain.
export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;

  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
