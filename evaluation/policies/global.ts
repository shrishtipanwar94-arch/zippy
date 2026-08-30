// THE POLICY UNDER TEST — the production solver, called directly.
//
// This file is deliberately almost empty, and that is the point. It does not
// re-derive candidates, re-filter feasibility, re-score cost or re-run the
// assignment: it calls `solve()` from src/engine and reads the answer. If the
// harness reported a number this policy produced, the code that produced it
// is the code that ships.
//
// WHICH OF THE THREE PLANS. `solve()` returns one plan per weight vector, and
// a dispatcher chooses between them. A harness has no dispatcher, so it takes
// BALANCED every time — fixed rather than chosen per scenario, because
// picking the best-performing vector per scenario after seeing the results is
// exactly the tuning the phase forbids. FASTEST_RESOLUTION would very likely
// score better on the headline metric; using it would be choosing the
// scoreboard to suit the player.

import { solve } from '../../src/engine/solve.js';
import { haversineTravelTimes } from '../../src/infra/routing.js';
import type { PolicyDecision, PolicyInput } from './index.js';

const PLAN_UNDER_TEST = 'BALANCED';

export async function globalPolicy(input: PolicyInput): Promise<PolicyDecision[]> {
  const outcome = await solve({
    jobs: input.jobs,
    snapshot: input.snapshot,
    now: input.now,
    jobZone: input.jobZone,
    zonePartitionThreshold: input.zonePartitionThreshold,
    travelTimes: haversineTravelTimes,
  });

  const plan = outcome.plans.find((candidate) => candidate.label === PLAN_UNDER_TEST);
  if (!plan) return [];

  // Each assignment carries the option it was chosen from, so the runner gets
  // the travel time and resolvable faults from the same evaluation that made
  // the decision. Regenerating candidates here would be a second answer to a
  // question this run already answered, and the two could disagree.
  return plan.assignments.map((assignment) => ({
    jobId: assignment.jobId,
    option: assignment.option,
  }));
}
