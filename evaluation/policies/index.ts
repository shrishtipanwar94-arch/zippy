// THE FOUR POLICIES, and the one rule they all obey.
//
// EVERY policy runs the PRODUCTION candidate generator and the PRODUCTION
// feasibility filter. That is not a convenience — it is what stops the
// comparison being rigged. A "nearest unit" baseline that ignored capability
// constraints would lose to global for a reason that has nothing to do with
// the objective function: it would be losing because it dispatched a bike to
// a tow. Holding hard constraints identical across all four means the only
// thing that varies is WHICH feasible option gets chosen, which is the actual
// question.
//
// What varies between them:
//   fifo                       first feasible option, jobs in arrival order
//   nearest-unit               the option that arrives soonest
//   skill-aware                the option most likely to fix it in one visit
//   capability-aware-global    src/engine/solve.ts — cost, then Hungarian
//
// The first three are greedy: they take jobs one at a time and never revise.
// The fourth solves all pending jobs as one assignment problem. That is the
// difference the project exists to measure.

import type { DispatchOption, DispatchSnapshot, JobForDispatch } from '../../src/engine/candidates.js';
import { greedyPolicy } from './greedy.js';
import { globalPolicy } from './global.js';

export type PolicyInput = {
  // Pending jobs, oldest first. A greedy policy consumes them in this order.
  jobs: JobForDispatch[];
  snapshot: DispatchSnapshot;
  now: Date;
  jobZone: Map<string, string>;
  zonePartitionThreshold: number;
};

// The option is carried, not just the ids, because the runner needs its
// travel time and its `resolvableFaults` to work out what happens when the
// crew arrives.
export type PolicyDecision = { jobId: string; option: DispatchOption };

export type Policy = {
  name: string;
  description: string;
  decide: (input: PolicyInput) => Promise<PolicyDecision[]>;
};

// FIFO takes the first feasible option it is handed. Candidate order is the
// snapshot's unit order, which is stable — so this is "any feasible unit",
// deterministically, and it is the floor every other policy has to beat.
const fifo: Policy = {
  name: 'fifo',
  description: 'first feasible unit, jobs in arrival order',
  decide: greedyPolicy(() => 0),
};

const nearestUnit: Policy = {
  name: 'nearest-unit',
  description: 'the unit that arrives soonest',
  decide: greedyPolicy((option) => option.estimatedTravelMinutes),
};

// Rank by how much of the fault distribution the crew can actually resolve,
// breaking ties on arrival. This is a genuinely strong baseline — it optimises
// first-visit resolution directly — and it is the one global has to beat on
// something other than capability coverage.
const skillAware: Policy = {
  name: 'skill-aware',
  description: 'the crew most likely to fix it in one visit, ties on arrival',
  decide: greedyPolicy(
    (option) => -option.coveredFaultProbability * 10_000 + option.estimatedTravelMinutes,
  ),
};

const capabilityAwareGlobal: Policy = {
  name: 'capability-aware-global',
  description: 'src/engine/solve.ts — expected time to resolution, assigned globally',
  decide: globalPolicy,
};

export const POLICIES: Policy[] = [fifo, nearestUnit, skillAware, capabilityAwareGlobal];

export const POLICY_NAMES = POLICIES.map((policy) => policy.name);

export function policyByName(name: string): Policy {
  const policy = POLICIES.find((candidate) => candidate.name === name);
  if (!policy) {
    throw new Error(`unknown policy "${name}" — known: ${POLICY_NAMES.join(', ')}`);
  }
  return policy;
}
