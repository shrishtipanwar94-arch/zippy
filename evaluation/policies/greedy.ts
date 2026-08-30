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
// Extracted into one function at the third repetition, not before: fifo,
// nearest-unit and skill-aware differ only in `rank`.

import { generateCandidates } from '../../src/engine/candidates.js';
import type { DispatchOption } from '../../src/engine/candidates.js';
import { checkFeasibility } from '../../src/engine/feasibility.js';
import { haversineTravelTimes } from '../../src/infra/routing.js';
import type { PolicyDecision, PolicyInput } from './index.js';

// Lower is better. Every greedy policy is this function plus a comparator.
export type RankOption = (option: DispatchOption) => number;

export function greedyPolicy(rank: RankOption) {
  return async function decide(input: PolicyInput): Promise<PolicyDecision[]> {
    const decisions: PolicyDecision[] = [];
    // One unit can serve one job (invariant 7), so a unit chosen for an
    // earlier job is gone for every later one. This set is the greedy
    // commitment made concrete.
    const taken = new Set<string>();

    for (const job of input.jobs) {
      const options = await generateCandidates(job, input.snapshot, haversineTravelTimes);
      const { feasible } = checkFeasibility(options, job, input.snapshot, input.now);

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
