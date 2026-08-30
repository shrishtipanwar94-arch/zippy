// ORDERING THE FEASIBLE OPTIONS — and the one place safety enters dispatch.
//
// INVARIANT 4: SAFETY IS A LEXICOGRAPHIC ORDERING ABOVE THE COST FUNCTION,
// NOT A TERM INSIDE IT.
//
// The tempting shortcut is a sixth weighted term — "add a safety bonus for
// arriving quickly at a HIGH_RISK job" — and it is the same mistake invariant
// 3 rules out for hard constraints, one level up. A weighted term can always
// be outvoted: give the arithmetic a big enough distance difference, a tight
// enough SLA on some other axis, an expensive enough option, and the sum
// eventually prefers the slower unit for a driver standing on a live
// carriageway. That is not a tuning failure to be fixed with a bigger
// coefficient; it is what a weighted sum MEANS.
//
// A lexicographic comparator cannot be outvoted. For a HIGH_RISK job it sorts
// on arrival time and only consults cost to break a tie — so no combination
// of cost terms can ever reorder two options whose arrival times differ. Cost
// still ranks everything; it simply ranks second.
//
// This lives in its own file rather than in cost.ts for a reason worth
// keeping: the build plan's own check greps cost.ts to prove safety is not a
// term in it. Splitting the comparator out is not a trick to satisfy the
// grep — it is the grep correctly detecting that a comparator wrapping the
// ranking is not part of the thing being wrapped.

import type { DispatchOption, JobForDispatch } from './candidates.js';
import { scoreOption } from './cost.js';
import type { CostBreakdown, WeightVectorName } from './cost.js';

export type ScoredOption = {
  option: DispatchOption;
  cost: CostBreakdown;
};

// Ties break on unitId last, always. Two options with identical arrival and
// identical cost must not order differently between two runs of the same
// seeded scenario, or the Phase 10 evaluation harness cannot compare
// anything — the same input has to produce the same ranked list every time.
function byCostThenArrival(a: ScoredOption, b: ScoredOption): number {
  if (a.cost.total !== b.cost.total) return a.cost.total - b.cost.total;
  if (a.option.estimatedTravelMinutes !== b.option.estimatedTravelMinutes) {
    return a.option.estimatedTravelMinutes - b.option.estimatedTravelMinutes;
  }
  return a.option.unitId.localeCompare(b.option.unitId);
}

function byArrivalThenCost(a: ScoredOption, b: ScoredOption): number {
  if (a.option.estimatedTravelMinutes !== b.option.estimatedTravelMinutes) {
    return a.option.estimatedTravelMinutes - b.option.estimatedTravelMinutes;
  }
  if (a.cost.total !== b.cost.total) return a.cost.total - b.cost.total;
  return a.option.unitId.localeCompare(b.option.unitId);
}

// Exported so the choice itself is testable without going through scoring —
// "which comparator does a HIGH_RISK job get" is the invariant, and it should
// be assertable directly.
export function comparatorFor(job: JobForDispatch): (a: ScoredOption, b: ScoredOption) => number {
  return job.safetyLevel === 'HIGH_RISK' ? byArrivalThenCost : byCostThenArrival;
}

// Scores every option and returns them ordered best-first. The input array is
// not mutated — a caller holding the feasible list from feasibility.ts still
// has it in its original order afterwards.
export function rankOptions(
  options: DispatchOption[],
  job: JobForDispatch,
  now: Date,
  weightVector: WeightVectorName = 'BALANCED',
): ScoredOption[] {
  const scored = options.map((option) => ({
    option,
    cost: scoreOption(option, job, now, weightVector),
  }));

  return scored.sort(comparatorFor(job));
}
