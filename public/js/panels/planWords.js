// THE FOUR PLANS, IN WORDS — the same arrangement as ./rejectionWords.js, for
// the same reason and one rung up.
//
// A weight vector's name is a constant in src/engine/cost.ts and a badge on a
// plan card, and in both those places printing `PROTECT_CONTRACTS` is right: a
// card is a label and a label is allowed to be a code. Inside a SENTENCE it is
// jargon — "The PROTECT_CONTRACTS plan would have sent somebody else" is not a
// thing a dispatcher says out loud, and the trace and the inspector are both
// prose.
//
// ONE ADJECTIVAL FORM, used by both readers, so "the lowest-cost plan" and a
// list of "the fastest-resolution, lowest-cost, balanced and contract-
// protecting plans" come out of the same map and cannot drift apart. Asserted
// against the engine's WEIGHT_VECTORS by tests/unassignedReasons.test.ts — the
// console has no build step and cannot import the engine's types, so a test
// does what a compiler would.

export const PLAN_WORDS = {
  FASTEST_RESOLUTION: 'fastest-resolution',
  LOWEST_COST: 'lowest-cost',
  BALANCED: 'balanced',
  PROTECT_CONTRACTS: 'contract-protecting',
};

// Falls back to the label itself rather than to a guess. A vector added to the
// engine and forgotten here reads as the code — ugly, and true, which is the
// right way round for the two to be caught.
export function planWord(label) {
  return PLAN_WORDS[label] ?? label;
}

// "the fastest-resolution, lowest-cost, balanced and contract-protecting plans"
export function describePlans(labels) {
  const words = (labels ?? []).map(planWord);
  if (words.length === 0) return '';
  if (words.length === 1) return `the ${words[0]} plan`;
  return `the ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]} plans`;
}
