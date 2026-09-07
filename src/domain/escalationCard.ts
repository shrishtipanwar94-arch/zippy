// WHEN NO PLAN EXISTS — what a dispatcher is shown instead of a blank screen.
//
// UNSERVICEABLE IS NOT AN END STATE, it is a handover. The solver has already
// worked out exactly why every option failed (src/engine/feasibility.ts keeps
// a reason code per rejected option, which is the whole reason those codes are
// a first-class output rather than debug logging). This file turns that into
// the five things a person needs in order to act:
//
//   1. the reason, with its specific code — never "no units available"
//   2. the closest option that WOULD have worked, and what stopped it
//   3. the alternative that does not need this fleet at all
//   4. a recommendation, because a dispatcher under pressure should not have
//      to derive one from a list
//   5. the actions available, so the handover ends in a decision
//
// THE RECOMMENDATION IS RULES, NOT A MODEL. Invariant 5 again: an LLM never
// decides, and this is a decision aid at the sharpest end of the system. Every
// sentence below is derived from a reason code by a table anybody can read.
//
// PURE. Takes the rejections and returns the card.

import type { RejectionCode } from '../engine/feasibility.js';

export type RejectedOptionView = {
  unitId: string;
  unitCode: string;
  technicianName: string | null;
  code: RejectionCode;
  detail: string;
  travelMinutes: number;
  // What the unit would have needed and did not have. Empty for rejections
  // that are not about capability.
  missingCapabilities: string[];
};

export type EscalationAction =
  | 'APPROVE_ANYWAY'
  | 'FIND_EXTERNAL_PROVIDER'
  | 'CONTACT_DRIVER';

export type EscalationCard = {
  jobId: string;
  // The single code that best explains why this job has no plan: the one the
  // most options failed on. Ties break towards the code that appears first in
  // the feasibility file's own ordering, which is its "most fundamental first"
  // ordering.
  reasonCode: RejectionCode;
  reason: string;
  // The option that came closest — the fastest one whose rejection a human can
  // actually do something about. Null when nothing was even generated.
  closest: RejectedOptionView | null;
  closestExplanation: string | null;
  alternative: string;
  recommendation: string;
  actions: EscalationAction[];
};

// Plain language for every code the feasibility engine can produce, and what a
// person can do about each. `alternative` deliberately names something OUTSIDE
// this fleet: the point of the card is that the automatic system has run out
// of options, so an alternative inside it would be no alternative at all.
const REASONS: Record<
  RejectionCode,
  { reason: string; alternative: string; recommendation: string }
> = {
  UNIT_UNAVAILABLE: {
    reason: 'Every unit that could do this work is already on another job.',
    alternative: 'A partner operator, or this job waits for the first unit to finish.',
    recommendation: 'Check when the nearest suitable unit frees up. If it is longer than the driver can wait, call an external provider.',
  },
  VEHICLE_TYPE_INCOMPATIBLE: {
    reason: 'No unit in range can physically handle this vehicle.',
    alternative: 'A heavy-recovery partner with the right equipment.',
    recommendation: 'This will not resolve by waiting — find an external provider with suitable equipment.',
  },
  CAPABILITY_MISSING: {
    reason: 'No available crew holds every skill this fault needs.',
    alternative: 'A specialist partner, or a tow to a workshop that has the skill.',
    recommendation: 'Consider a tow to a workshop instead of a roadside repair, or approve a partner callout.',
  },
  ACCESS_RESTRICTION: {
    reason: 'Units that could do the work cannot physically reach the vehicle.',
    alternative: 'A smaller unit, or moving the vehicle to an accessible point.',
    recommendation: 'Call the driver: if the vehicle can be moved to a reachable spot, a unit already nearby can take it.',
  },
  NO_TECHNICIAN_ON_SHIFT: {
    reason: 'The units that could do this work have no technician on shift.',
    alternative: 'An on-call technician, or a partner operator.',
    recommendation: 'Check the on-call roster before going external — this is a staffing gap, not a capability one.',
  },
  SLA_UNREACHABLE: {
    reason: 'Nobody can reach this vehicle inside its promised response time.',
    alternative: 'A partner operator closer to the vehicle.',
    recommendation: 'Decide whether to send the nearest unit late and tell the driver, or hand it to a partner who is closer.',
  },
  PART_UNAVAILABLE: {
    reason: 'No unit in range carries the parts this repair needs.',
    alternative: 'A tow to a workshop, or a restock run before dispatch.',
    recommendation: 'A tow is usually faster than restocking. Confirm the diagnosis with the driver first.',
  },
  NO_DESTINATION_AVAILABLE: {
    reason: 'This job needs a tow and no destination will accept the vehicle.',
    alternative: 'A workshop outside the usual list, or a holding yard.',
    recommendation: 'Call round the destinations directly — this is an availability problem, not a routing one.',
  },
  DESTINATION_NOT_AUTHORISED: {
    reason: 'No reachable, open workshop is authorised to service this brand.',
    alternative: 'A workshop outside the brand list, or a longer tow to one that is authorised.',
    recommendation: 'Call the manufacturer network for an exception, or confirm with the customer before sending it somewhere unauthorised.',
  },
  DESTINATION_EV_CLASS_MISMATCH: {
    reason: 'A workshop is authorised for this brand, but none reachable is equipped for this EV class.',
    alternative: 'A further-out workshop with the right EV certification.',
    recommendation: 'Widen the search radius before anything else — this is usually a distance problem wearing an authorisation code.',
  },
  TENANT_CONTRACT_EXCLUDES: {
    reason: "This work is outside the customer's contract.",
    alternative: 'A customer-paid callout.',
    recommendation: 'Call the driver and confirm they will pay before dispatching anybody.',
  },
};

// Rejections a human can plausibly clear, most-clearable first. "Closest" does
// not mean "nearest van" — it means the nearest van whose problem is worth
// showing to a person, which is a different and more useful question. A unit
// that is fifty metres away and physically cannot climb the ramp is not close
// to being an answer.
const HUMANLY_CLEARABLE: RejectionCode[] = [
  'ACCESS_RESTRICTION',
  'NO_TECHNICIAN_ON_SHIFT',
  'SLA_UNREACHABLE',
  'UNIT_UNAVAILABLE',
  'PART_UNAVAILABLE',
  'DESTINATION_NOT_AUTHORISED',
  'DESTINATION_EV_CLASS_MISMATCH',
  'TENANT_CONTRACT_EXCLUDES',
  'NO_DESTINATION_AVAILABLE',
  'CAPABILITY_MISSING',
  'VEHICLE_TYPE_INCOMPATIBLE',
];

// THE BREAKDOWN, IN ONE LINE — "NO_TECHNICIAN_ON_SHIFT x23, SLA_UNREACHABLE x1".
//
// The card above is what a dispatcher reads once they have opened a job. This
// is what goes on the action row in the worklist, BEFORE anybody has clicked
// anything, and the difference matters: a card nobody opens explains nothing.
// A re-plan that found no crew used to leave no trace at all, and an evening
// went into concluding the dispatch path was broken when it had correctly
// worked out that every van was off shift. That sentence, on the queue, is the
// whole fix.
//
// CODES RATHER THAN PROSE, deliberately, and it is the one place on an operator
// surface where that is the right call. The reason sentence is one line further
// down the same card; this line is for scanning, and an operator who has seen
// NO_TECHNICIAN_ON_SHIFT x23 twice this week has learned something about their
// roster that "the units that could do this work have no technician on shift"
// x23 would have buried.
//
// Ordered by count, then by code, so the same rejections always produce the
// same sentence — this string goes in a reason column an operator compares
// between two jobs.
export function describeRejectionCounts(codes: RejectionCode[]): string {
  if (codes.length === 0) return 'no unit was even considered';

  const counts = new Map<RejectionCode, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${code} x${count}`)
    .join(', ');
}

export function buildEscalationCard(
  jobId: string,
  rejections: RejectedOptionView[],
): EscalationCard {
  const reasonCode = dominantCode(rejections);
  const wording = REASONS[reasonCode];
  const closest = closestClearable(rejections);

  return {
    jobId,
    reasonCode,
    reason: wording.reason,
    closest,
    closestExplanation: closest ? explainClosest(closest) : null,
    alternative: wording.alternative,
    recommendation: wording.recommendation,
    // Always all three. The dispatcher decides; the system does not get to
    // decide which decisions they are allowed to make.
    actions: ['APPROVE_ANYWAY', 'FIND_EXTERNAL_PROVIDER', 'CONTACT_DRIVER'],
  };
}

// The code the most options failed on. An empty list means the solver never
// generated an option at all — no unit exists in the zone — which reads as
// "everything is busy" to an operator and is the honest default.
function dominantCode(rejections: RejectedOptionView[]): RejectionCode {
  if (rejections.length === 0) return 'UNIT_UNAVAILABLE';

  const counts = new Map<RejectionCode, number>();
  for (const rejection of rejections) {
    counts.set(rejection.code, (counts.get(rejection.code) ?? 0) + 1);
  }

  let best: RejectionCode = rejections[0]!.code;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function closestClearable(rejections: RejectedOptionView[]): RejectedOptionView | null {
  const ranked = [...rejections].sort((a, b) => {
    const byClearability =
      HUMANLY_CLEARABLE.indexOf(a.code) - HUMANLY_CLEARABLE.indexOf(b.code);
    if (byClearability !== 0) return byClearability;
    return a.travelMinutes - b.travelMinutes;
  });
  return ranked[0] ?? null;
}

function explainClosest(option: RejectedOptionView): string {
  const who = option.technicianName ? `${option.unitCode} (${option.technicianName})` : option.unitCode;
  const eta = `${Math.round(option.travelMinutes)} min away`;

  if (option.code === 'CAPABILITY_MISSING' && option.missingCapabilities.length > 0) {
    return `${who} is ${eta} but is missing ${option.missingCapabilities.join(', ')}.`;
  }
  return `${who} is ${eta} but was rejected: ${option.detail}.`;
}
