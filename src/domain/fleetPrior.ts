// A FLEET VEHICLE'S OWN HISTORY, AS A STARTING PRIOR.
//
// `FAULT_PRIORS` (src/domain/faults.ts) says how common each fault is across
// EVERY vehicle this system has ever seen. A fleet vehicle that has already
// broken down twice with a flat battery is not "every vehicle" — its own
// record already says something the base rate cannot: this one is a battery
// van. Intake should start from that, not rediscover it from scratch on every
// call-out.
//
// A RULE, NOT A MODEL — the phase brief's own words, and worth restating here
// because this is the file that could quietly drift into being one. Nothing
// here is fitted, trained or estimated from a dataset. Each past incident is
// folded into the belief through the SAME multiplicative Bayes update every
// symptom answer already goes through (src/domain/entropy.ts's
// `applyLikelihood`) — a hand-set likelihood row saying "a vehicle with this
// history is somewhat more likely to have this fault again, and only somewhat"
// — so a repeat incident is treated exactly like a mild secondhand observation,
// never like a diagnosis. Labelled as a rule everywhere it reaches a person:
// the fleet dashboard UI and this comment. See also the REPEAT-PATTERN FLAG in
// src/domain/repeatPattern.ts, a separate rule over the same history answering
// a different question — "should the fleet manager's maintenance team look at
// this vehicle", not "what does dispatch believe right now".

import { FAULT_CODES } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';
import { applyLikelihood } from './entropy.js';

// The matched fault gets a real nudge; everything else is mildly discounted
// rather than ruled out — the same shape every LikelihoodRow in faultRules.ts
// takes for "this observation favours one thing but proves nothing". Chosen by
// hand against the rule table, the same way ENTROPY_STOP_THRESHOLD_BITS was:
// two same-fault incidents should visibly sharpen the prior without making the
// vehicle's actual symptoms this time stop mattering.
const REPEAT_INCIDENT_MATCH_LIKELIHOOD = 0.5;
const REPEAT_INCIDENT_OTHER_LIKELIHOOD = 0.2;

// Only the most recent few incidents count. Bounding the fold-in is what keeps
// this a rule somebody can defend rather than an unbounded compound multiply —
// a vehicle with forty incidents on file should not become certain before a
// single symptom is asked about, and an old pattern is weaker evidence than a
// fresh one regardless of how many rows are in the table.
export const MAX_PRIOR_INCIDENTS = 5;

function repeatIncidentRow(matchedFault: FaultCode): Record<FaultCode, number> {
  const row = {} as Record<FaultCode, number>;
  for (const fault of FAULT_CODES) {
    row[fault] = fault === matchedFault ? REPEAT_INCIDENT_MATCH_LIKELIHOOD : REPEAT_INCIDENT_OTHER_LIKELIHOOD;
  }
  return row;
}

// `priorFaults` — most recent first, already capped by the caller's query
// (src/commit/fleetPrior.ts) but capped again here so this function's own
// contract does not depend on a caller remembering to. Empty means no history
// at all, and the baseline is returned unchanged — a vehicle with no incidents
// on file gets exactly the same prior a stranger's vehicle would.
export function fleetVehiclePrior(
  baseline: FaultDistribution,
  priorFaults: FaultCode[],
): FaultDistribution {
  let distribution = baseline;
  for (const fault of priorFaults.slice(0, MAX_PRIOR_INCIDENTS)) {
    distribution = applyLikelihood(distribution, repeatIncidentRow(fault));
  }
  return distribution;
}
