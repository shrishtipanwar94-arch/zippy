// THE NINE METRICS, plus the two counts that stop the others lying.
//
// UNRESOLVED JOBS ARE REPORTED, and this is not decoration. Every mean below
// is taken over jobs that actually finished. A policy that strands a third of
// the board and resolves the easy two-thirds quickly would post a beautiful
// meanTimeToResolution, and the only thing standing between that number and a
// false claim is `resolved` printed next to it. Read the means without the
// resolved count and you will draw the wrong conclusion.
//
// EARNINGS GINI IS MEASURED, NEVER OPTIMISED (the phase is explicit, and so is
// the cost function — src/engine/cost.ts contains no fairness term). It is
// here to show what optimising purely for resolution time does to the spread
// of work across a workforce, which is a real cost even though nothing in the
// system currently trades against it.
//
// SOLVER WALL CLOCK IS THE ONE NON-REPRODUCIBLE NUMBER here. Two runs of one
// seed produce identical decisions and identical durations in simulated
// minutes, but never identical milliseconds. It is therefore reported
// separately from the deterministic table — see report.ts.

import type { RunResult } from './runner.js';

export type Metrics = {
  jobCount: number;
  resolvedCount: number;
  dispatchedCount: number;
  // Jobs no policy ever managed to send anyone to. Reported because the
  // difference between "served slowly" and "never served" is invisible in
  // every mean below, and it is the difference a customer notices.
  strandedCount: number;
  firstVisitResolutionRate: number;
  meanTimeToArrivalMinutes: number;
  meanTimeToResolutionMinutes: number;
  secondDispatchRate: number;
  slaBreaches: number;
  // Wasted visits where the crew had the SKILL and not the PART. The number
  // Phase 19 exists to move, and the only one that separates "we sent the
  // wrong person" from "we sent the right person empty-handed". A policy with
  // no inventory model cannot avoid these; it cannot even see them.
  stockoutInducedFailures: number;
  unitUtilisation: number;
  earningsGini: number;
  solverWallClockP95Ms: number;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// The p95 by nearest-rank: the smallest value at or above which 95% of the
// sample sits. On a short sample this is simply the top few — stated because
// a p95 over eleven decisions is not the same claim as a p95 over a thousand.
function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

// GINI COEFFICIENT: 0 is perfectly even, 1 is one technician taking
// everything. Computed the standard way — the mean absolute difference
// between every pair, normalised by twice the mean.
//
// Technicians who earned nothing ARE included. Excluding them would be the
// single easiest way to make an unfair distribution look fair: a policy that
// funnels every job to six of thirty-one crews scores well on a Gini taken
// over "technicians who worked".
export function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;

  let absoluteDifferences = 0;
  for (const a of values) {
    for (const b of values) absoluteDifferences += Math.abs(a - b);
  }

  return absoluteDifferences / (2 * values.length * total);
}

export function computeMetrics(run: RunResult, technicianIds: string[]): Metrics {
  const dispatched = run.jobs.filter((job) => job.dispatchCount > 0);
  const resolved = run.jobs.filter((job) => job.resolvedMinute !== null);

  const arrivalDelays = dispatched
    .filter((job) => job.firstArrivalMinute !== null)
    .map((job) => job.firstArrivalMinute! - job.arrivalMinute);

  const resolutionDelays = resolved.map((job) => job.resolvedMinute! - job.arrivalMinute);

  // An SLA is breached when the FIRST crew arrives after the promised window.
  // A job never dispatched at all also breaches it — leaving someone at the
  // roadside is not a way to avoid missing a deadline, and counting only
  // dispatched jobs would reward exactly that.
  const slaBreaches = run.jobs.filter((job) => {
    if (job.slaResponseMinutes === null) return false;
    if (job.firstArrivalMinute === null) return true;
    return job.firstArrivalMinute - job.arrivalMinute > job.slaResponseMinutes;
  }).length;

  const busyTotal = [...run.unitBusyMinutes.values()].reduce((sum, value) => sum + value, 0);
  const capacity = run.unitCount * run.horizonMinutes;

  const earnings = technicianIds.map((id) => run.technicianBusyMinutes.get(id) ?? 0);

  return {
    jobCount: run.jobs.length,
    resolvedCount: resolved.length,
    dispatchedCount: dispatched.length,
    strandedCount: run.jobs.length - dispatched.length,
    firstVisitResolutionRate:
      dispatched.length === 0
        ? 0
        : dispatched.filter((job) => job.firstVisitResolved).length / dispatched.length,
    meanTimeToArrivalMinutes: mean(arrivalDelays),
    meanTimeToResolutionMinutes: mean(resolutionDelays),
    secondDispatchRate:
      dispatched.length === 0
        ? 0
        : dispatched.filter((job) => job.dispatchCount > 1).length / dispatched.length,
    slaBreaches,
    stockoutInducedFailures: run.jobs.reduce((sum, job) => sum + job.stockoutFailures, 0),
    unitUtilisation: capacity === 0 ? 0 : busyTotal / capacity,
    earningsGini: gini(earnings),
    solverWallClockP95Ms: percentile95(run.decisionMillis),
  };
}
