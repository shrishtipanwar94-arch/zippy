// WHAT A CONTRACT PROMISE IS WORTH, AS MONEY.
//
// CONTRACT SLA IS A COST TERM. FAIRNESS IS NOT. That asymmetry is the whole
// reason this file exists, and it is the question this phase makes answerable:
//
//   A contract breach is a QUANTIFIED OBLIGATION. Somebody signed a document
//   saying that arriving after thirty minutes costs a named number of rupees.
//   Pricing it into the objective is not the system expressing a preference,
//   it is the system reading a number off a contract and adding it to the other
//   numbers it already trades against each other — fuel, wear, paid time.
//
//   An even distribution of earnings across technicians is a POLICY
//   PREFERENCE. Nobody owes it, nothing measures it in rupees, and there is no
//   defensible exchange rate between "this technician has had a thin week" and
//   "this driver is stranded". So it stays out of the cost function and is
//   measured as an OUTCOME of a whole run instead (evaluation/metrics.ts,
//   earnings Gini) — the same treatment cost.ts already gives it.
//
// AND SAFETY IS NEITHER. Safety is not in here at all: it is a lexicographic
// ordering above every cost term (invariant 4, src/engine/ranking.ts and the
// safety bands in src/engine/solve.ts). A GOLD contract with a large penalty
// must never be able to outbid a consumer standing on a live carriageway, and
// the only way to guarantee that is to keep the two in different layers.
//
// Pure. Minutes and paise in, paise out. No clock, no database.
//
// THE PAISE HERE ARE NOT `Paise`. src/domain/money.ts's rule is that BOOKED
// money is whole integer paise; an exposure is an EXPECTED value — a
// probability times a penalty — and rounding it to a whole paise before it is
// multiplied by a weight and added to four other terms would be pretending to
// a precision it does not have. Same treatment cost.ts already gives
// `operationalCostPaise`. Nothing in this file is ever written to a ledger.

// The terms a job was pinned to at creation and is served under whatever
// happens to the contract afterwards. Null on a job with no contract behind
// it — a walk-in consumer, who is owed care but not damages.
// ONE FACT, ONE HOME: the response window is NOT in here. It already lives on
// the job as `slaResponseMinutes` (src/engine/candidates.ts), where feasibility
// and priority.ts both read it, and a second copy on these terms would be one
// edit away from disagreeing with the first.
export type ContractTerms = {
  tier: ContractTierSnapshot;
  breachPenaltyPaise: number;
};

// Mirrors Prisma's ContractTierName as a plain union so the engine can hold
// one without importing the generated client — the same rule and the same
// reason as UnitKindSnapshot in src/engine/candidates.ts.
export const CONTRACT_TIERS = ['GOLD', 'SILVER', 'BRONZE', 'NONE'] as const;
export type ContractTierSnapshot = (typeof CONTRACT_TIERS)[number];

// Below this share of the remaining window, an arrival estimate is treated as
// safe. Hand-set, like every other threshold in this project, and stated as
// such: nothing has been measured about how often a travel estimate that fits
// with room to spare turns into a breach.
const SAFE_SHARE_OF_REMAINING_WINDOW = 0.5;

// HOW LIKELY THIS OPTION IS TO MISS THE PROMISED WINDOW.
//
// Deliberately a ruler, not a model. An estimate that eats half the remaining
// window or less is treated as safe; from there the probability rises linearly
// to certainty as the estimate approaches the deadline, because an arrival that
// only just fits is one closed lane away from not fitting. A real estimator
// would need a distribution of travel-time error that this project has never
// measured, and inventing one would be claiming knowledge it does not have.
export function breachProbability(arrivalMinutes: number, remainingMinutes: number): number {
  // The window has already closed. The breach is not a risk any more, it is a
  // fact, and saying so is what makes `avoidedBreachPenaltyPaise` below come
  // out at zero for these jobs without a second special case.
  if (remainingMinutes <= 0) return 1;

  const share = arrivalMinutes / remainingMinutes;
  if (share <= SAFE_SHARE_OF_REMAINING_WINDOW) return 0;
  if (share >= 1) return 1;

  return (share - SAFE_SHARE_OF_REMAINING_WINDOW) / (1 - SAFE_SHARE_OF_REMAINING_WINDOW);
}

// WHAT SENDING THIS CREW SAVES: (1 - P(breach)) x penalty.
//
// THE BASELINE IS "NOBODY GOES", AND THAT IS THE WHOLE SUBTLETY OF THIS PHASE.
// Every other cost term compares one option against another option, so
// measuring what it COSTS is enough. A contract penalty cannot be measured that
// way, because the thing a contract job is really competing against is not a
// different van — it is not being served at all. The assignment problem prices
// "not served" as one flat sentinel for every job (UNAVAILABLE_COST in
// src/engine/allocation.ts, deliberately uniform: it means "there is nothing
// here to choose", not "this is very bad"). So the only place the penalty for
// going unserved can enter the arithmetic is by shifting the served cells down
// by the amount a dispatch AVOIDS.
//
// Get this backwards and the system does the opposite of what it is for: price
// exposure as a positive cost on the served cell and a GOLD job becomes the
// EXPENSIVE job, so when one van is left the solver hands it to the consumer
// and leaves the contract breaching. Raising the weight makes it worse. The
// sign is not a presentation choice.
//
// It is a CREDIT, never a reward for being late: an option arriving with the
// window already gone saves nothing (P = 1, so the credit is zero) and an
// option arriving comfortably saves the whole penalty. A dispatch cannot earn
// anything by being slow.
//
// Zero for a job with no contract, which is the honest answer rather than a
// small number: there is nothing to avoid.
export function avoidedBreachPenaltyPaise(
  terms: ContractTerms | null,
  arrivalMinutes: number,
  remainingMinutes: number,
): number {
  if (!terms) return 0;
  if (terms.breachPenaltyPaise <= 0) return 0;

  return (1 - breachProbability(arrivalMinutes, remainingMinutes)) * terms.breachPenaltyPaise;
}

// How much of the promised window is left at `now`. Negative once it has
// closed — deliberately not clamped, for the same reason priority.ts does not
// clamp its own overrun: "two minutes late" and "an hour late" are different
// operational facts.
export function remainingWindowMinutes(
  responseMinutes: number,
  createdAt: Date,
  now: Date,
): number {
  const elapsedMinutes = (now.getTime() - createdAt.getTime()) / 60_000;
  return responseMinutes - elapsedMinutes;
}
