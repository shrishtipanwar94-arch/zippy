// WHEN A CONTRACT JOB AND A CONSUMER JOB WANT THE SAME VAN.
//
// This is the moment the tenancy layer stops being bookkeeping and becomes a
// decision somebody can be angry about. Two people are stranded. One of them
// signed a contract with a penalty clause and one of them did not. There is one
// van. At the same safety level, nothing in the objective function can settle
// that honestly — the arithmetic will always prefer the job with a priced
// obligation attached, and "we sent the van to the fleet because the fleet pays
// us" is a sentence no operator wants to discover after the fact.
//
// SO THE SYSTEM PRICES THE TRADE-OFF AND ESCALATES. It works out what each
// choice costs, writes both numbers down, and asks a human. A system that
// silently chooses which paying customer to disappoint is a system nobody
// deploys.
//
// TWO SCALES, ONE QUESTION, WHICH IS WHY BOTH LIVE HERE:
//   findContestedResources  — one unit, two jobs. The APPROVE card.
//   deprioritisedConsumerJobs — a whole plan. The warning line on the
//                               PROTECT_CONTRACTS plan card, so a dispatcher
//                               choosing that plan sees what it gives up
//                               BEFORE they take it rather than afterwards.
//
// Pure, and deliberately over plain shapes rather than solver types: the input
// is "these jobs, these priced options, this plan", which is testable by hand.

export type ContentionJob = {
  id: string;
  // Whether a contract with a penalty clause stands behind this job. The
  // distinction the escalation exists for — not the tier, not the money, just
  // "is one of these two a paying contract and the other not".
  hasContract: boolean;
  safetyLevel: string;
};

// One feasible, scored option: what it would cost to send this unit to this
// job, under one weight vector.
export type ContentionOption = { jobId: string; unitId: string; cost: number };

export type ContentionAssignment = { jobId: string; unitId: string };

export type ContestedResource = {
  unitId: string;
  // The job the plan gave the unit to, and the job that went without.
  winnerJobId: string;
  loserJobId: string;
  // Both priced, which is the entire point of escalating rather than deciding:
  // a dispatcher is being asked to choose, so they are shown what each choice
  // costs under the same objective the solver used.
  winnerCost: number;
  loserCost: number;
  // Which of the two is the contract job. Named rather than inferred at the
  // call site so the card can say "the contract job wins" without recomputing.
  contractJobId: string;
  consumerJobId: string;
  safetyLevel: string;
};

// THE RULE, in one sentence: a job that got nothing, whose best option was a
// unit some OTHER job took, where exactly one of the two is contract-backed and
// both are at the same safety level.
//
// EACH CLAUSE EARNS ITS PLACE.
//   "got nothing"        — a job that was served has not lost anything.
//   "its best option"    — the contended resource is the one it actually
//                          wanted; a van it scored badly on is not a loss.
//   "exactly one"        — two contract jobs competing, or two consumers, is
//                          an ordinary scarcity problem the cost function is
//                          allowed to settle. This is only about the
//                          cross-tenant case.
//   "same safety level"  — a HIGH_RISK job beating a GOLD contract job is
//                          invariant 4 working correctly, not a trade-off
//                          anybody needs to approve. Escalating it would train
//                          operators to click through the one card that
//                          matters.
export function findContestedResources(input: {
  jobs: ContentionJob[];
  options: ContentionOption[];
  assignments: ContentionAssignment[];
  unassignedJobIds: string[];
}): ContestedResource[] {
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  const holderByUnit = new Map(input.assignments.map((a) => [a.unitId, a.jobId]));
  const costByJobAndUnit = new Map(input.options.map((o) => [`${o.jobId} ${o.unitId}`, o.cost]));

  const contested: ContestedResource[] = [];

  for (const loserId of input.unassignedJobIds) {
    const loser = jobsById.get(loserId);
    if (!loser) continue;

    const best = bestOptionFor(loserId, input.options);
    if (!best) continue;

    const winnerId = holderByUnit.get(best.unitId);
    if (!winnerId || winnerId === loserId) continue;

    const winner = jobsById.get(winnerId);
    if (!winner) continue;

    if (winner.safetyLevel !== loser.safetyLevel) continue;
    if (winner.hasContract === loser.hasContract) continue;

    const winnerCost = costByJobAndUnit.get(`${winnerId} ${best.unitId}`);
    // The winner holds the unit but was never scored on it under this vector —
    // it can only mean the assignment and the options came from different runs,
    // which is a wiring bug rather than a trade-off to escalate.
    if (winnerCost === undefined) continue;

    contested.push({
      unitId: best.unitId,
      winnerJobId: winnerId,
      loserJobId: loserId,
      winnerCost,
      loserCost: best.cost,
      contractJobId: winner.hasContract ? winnerId : loserId,
      consumerJobId: winner.hasContract ? loserId : winnerId,
      safetyLevel: loser.safetyLevel,
    });
  }

  return contested;
}

// Cheapest option for one job. Ties break on unitId so two runs over the same
// scored list name the same contested unit — the same determinism rule
// src/engine/ranking.ts follows.
function bestOptionFor(jobId: string, options: ContentionOption[]): ContentionOption | null {
  let best: ContentionOption | null = null;
  for (const option of options) {
    if (option.jobId !== jobId) continue;
    if (!best) {
      best = option;
      continue;
    }
    if (option.cost < best.cost) best = option;
    else if (option.cost === best.cost && option.unitId.localeCompare(best.unitId) < 0) best = option;
  }
  return best;
}

// WHAT THE PROTECT_CONTRACTS PLAN GIVES UP, measured against the plan the
// solver actually recommends. A consumer job that BALANCED would have served
// and this plan leaves waiting is the cost of protecting the contracts, and it
// has to be on the card. The trade-off is shown, never hidden.
export function deprioritisedConsumerJobs(input: {
  protectPlanUnassignedJobIds: string[];
  recommendedPlanUnassignedJobIds: string[];
  consumerJobIds: string[];
}): string[] {
  const servedByRecommended = new Set(input.recommendedPlanUnassignedJobIds);
  const consumers = new Set(input.consumerJobIds);

  return input.protectPlanUnassignedJobIds.filter(
    (jobId) => consumers.has(jobId) && !servedByRecommended.has(jobId),
  );
}
