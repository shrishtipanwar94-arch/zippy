// THE THREE GREEDY BASELINES, as one loop and three ranking keys.
//
// Greedy means: take the oldest pending job, give it the best option it can
// see right now, mark that unit taken, move to the next job. It never revises
// an earlier choice in the light of a later job. That is the behaviour the
// whole project is arguing against, so it has to be implemented faithfully
// rather than as a strawman — each of these three optimises its own objective
// correctly and completely.
//
// THE FAILURE IT IS BUILT TO EXHIBIT: the first job takes the only
// EV-certified crew because that crew is marginally better for it, and the EV
// job three positions down the queue then has nobody. No amount of care
// inside a per-job choice fixes that, because the information needed — that a
// later job needs this unit more — is not available when the choice is made.
//
// THEY ARE ALSO BLIND TO STOCK, from Phase 19 on, and that is the second thing
// they are built to exhibit. `stockBlind()` below blanks the parts half of the
// snapshot before candidate generation sees it, so these three choose a crew on
// skill and distance alone — which is what a dispatch system without an
// inventory model does. The world does NOT become stockless: the runner still
// meets the real shelf when the crew opens it, and counts every visit that
// failed for a part in `stockoutInducedFailures`. That column is the whole
// argument for the parts layer, and it would be unmeasurable if the baselines
// were quietly handed the same information the solver has.
//
// Extracted into one function at the third repetition, not before: fifo,
// nearest-unit and skill-aware differ only in `rank`.

import { generateCandidates } from '../../src/engine/candidates.js';
import type { DispatchOption, DispatchSnapshot } from '../../src/engine/candidates.js';
import { checkFeasibility } from '../../src/engine/feasibility.js';
import { haversineTravelTimes } from '../../src/infra/routing.js';
import type { PolicyDecision, PolicyInput } from './index.js';

// Lower is better. Every greedy policy is this function plus a comparator.
export type RankOption = (option: DispatchOption) => number;

// A snapshot with the parts model removed. `null` means "this picture does not
// describe stock", which candidate generation reads as "do not reason about
// parts" — NOT as "every van is empty". See src/engine/partSourcing.ts.
function stockBlind(snapshot: DispatchSnapshot): DispatchSnapshot {
  return { ...snapshot, parts: null };
}

export function greedyPolicy(rank: RankOption) {
  return async function decide(input: PolicyInput): Promise<PolicyDecision[]> {
    const decisions: PolicyDecision[] = [];
    // One unit can serve one job (invariant 7), so a unit chosen for an
    // earlier job is gone for every later one. This set is the greedy
    // commitment made concrete.
    const taken = new Set<string>();

    const snapshot = stockBlind(input.snapshot);

    for (const job of input.jobs) {
      const options = await generateCandidates(job, snapshot, haversineTravelTimes);
      const { feasible } = checkFeasibility(options, job, snapshot, input.now);

      const available = feasible.filter((option) => !taken.has(option.unitId));
      if (available.length === 0) continue;

      // A deterministic tie-break on unitId, so two options that rank equally
      // never depend on array order for the winner. Without it a scenario
      // could produce different assignments on two runs of the same seed.
      let best = available[0]!;
      for (const option of available) {
        const difference = rank(option) - rank(best);
        if (difference < 0 || (difference === 0 && option.unitId < best.unitId)) {
          best = option;
        }
      }

      taken.add(best.unitId);
      decisions.push({ jobId: job.id, option: best });
    }

    return decisions;
  };
}
