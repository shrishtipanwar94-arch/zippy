// REPEAT-PATTERN FLAG — highest value, least code.
//
// The phase brief's own words, and worth taking literally: this counts. Within
// a trailing window, how many times has THE SAME fault code shown up on THIS
// vehicle. Three or more and a fleet manager's maintenance team should look at
// the vehicle, because a van that keeps needing a jump-start does not need a
// faster dispatch — it needs a new battery.
//
// A RULE, NOT A MODEL. Say this everywhere the flag reaches a person — the
// fleet dashboard UI and DECISIONS.log both do. There is no training data, no
// confidence score, and nothing here gets smarter as incidents accumulate: it
// counts the fourth incident exactly the way it counted the third. The
// temptation this file exists to name and refuse is turning "count to three"
// into "predict which vehicle breaks down next" — that is a different, much
// harder claim, this project makes nowhere, and the DO NOT in the phase brief
// is explicit about it.
//
// NOT A DISPATCH PROBLEM. This never reaches the solver, the cost function or
// feasibility — it is purely an observation surfaced on the fleet manager's own
// dashboard, for their own maintenance team to act on. Pure function, no I/O.

import { FAULT_CODES } from './faults.js';
import type { FaultCode } from './faults.js';
import { labelForFault } from './driverNarrative.js';

// The phase brief's own example: "3rd battery incident in 60 days" — not a
// guess dressed as a constant, the threshold named in the spec.
export const REPEAT_PATTERN_MIN_COUNT = 3;
export const REPEAT_PATTERN_WINDOW_DAYS = 60;

export type VehicleIncident = {
  fault: FaultCode;
  at: Date;
};

export type RepeatPatternFlag = {
  fault: FaultCode;
  count: number;
  // The sentence a fleet manager reads, minus the vehicle's own registration —
  // that is a fact about the ROW, not about the rule, so the caller (which
  // already has it) prefixes it: "MH-04-7712 — " + this.
  message: string;
};

// Null when nothing has recurred often enough. Only the WORST pattern is
// reported when a vehicle has more than one — a dashboard row is a summary,
// not a case file, and the per-vehicle incident history underneath it has
// everything else.
export function repeatPatternFlag(incidents: VehicleIncident[], now: Date): RepeatPatternFlag | null {
  const windowStartMs = now.getTime() - REPEAT_PATTERN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const counts = new Map<FaultCode, number>();
  for (const incident of incidents) {
    if (incident.at.getTime() < windowStartMs) continue;
    counts.set(incident.fault, (counts.get(incident.fault) ?? 0) + 1);
  }

  // FAULT_CODES order, not insertion order, so two vehicles tied on count
  // always name the same fault — the same determinism rule the rest of the
  // engine follows, applied here for the same reason: a dashboard that
  // reshuffles its own flag between two identical loads is not trustworthy.
  let worst: { fault: FaultCode; count: number } | null = null;
  for (const fault of FAULT_CODES) {
    const count = counts.get(fault) ?? 0;
    if (count < REPEAT_PATTERN_MIN_COUNT) continue;
    if (!worst || count > worst.count) worst = { fault, count };
  }
  if (!worst) return null;

  return {
    fault: worst.fault,
    count: worst.count,
    message:
      `${ordinal(worst.count)} incident of ${labelForFault(worst.fault)} in ` +
      `${REPEAT_PATTERN_WINDOW_DAYS} days. Not a dispatch problem. Flagged for your maintenance team.`,
  };
}

function ordinal(n: number): string {
  const lastTwoDigits = n % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${n}th`;

  const lastDigit = n % 10;
  if (lastDigit === 1) return `${n}st`;
  if (lastDigit === 2) return `${n}nd`;
  if (lastDigit === 3) return `${n}rd`;
  return `${n}th`;
}
