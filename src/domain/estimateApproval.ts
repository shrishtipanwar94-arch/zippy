// WHEN THE DRIVER HAS TO BE ASKED AGAIN.
//
// The technician opens the car, and the job is bigger than the estimate the
// driver already said yes to. That is not an edge case — it is most of what
// makes roadside repair different from a quoted workshop job — and the whole
// question is how much bigger a revision may be before the earlier "yes" stops
// covering it.
//
// A TOLERANCE, IN BASIS POINTS OF THE APPROVED TOTAL. Configurable
// (`ESTIMATE_REAPPROVAL_TOLERANCE_BPS`) because it is a commercial policy
// rather than a fact: set it to 0 and every rupee is re-approved; set it high
// and small overruns carry. Basis points rather than a float percentage
// because money here is integers and a percentage stored as a float is a
// rounding argument waiting to happen.
//
// ONLY AN INCREASE ASKS AGAIN, and this is the rule most likely to be got
// wrong by someone reaching for `Math.abs`. A revision that comes in CHEAPER
// than the approved total needs no new approval — the driver already agreed to
// spend more than that, and stopping a job to tell somebody it will cost less
// is a pause that helps nobody and delays a repair. The comparison is
// deliberately one-directional.
//
// PURE. No config read here either: the tolerance is passed in, so a test can
// ask what happens at 0 bps and at 5000 without touching the environment.

import type { Paise } from './money.js';

export type ReapprovalQuery = {
  // What the driver has already said yes to. Null when they have approved
  // nothing yet — the first estimate on a job.
  approvedTotalPaise: Paise | null;
  revisedTotalPaise: Paise;
  toleranceBps: number;
};

export type ReapprovalDecision =
  // Nothing has been approved yet, so there is nothing for a revision to be
  // within. The first estimate always needs an answer.
  | { outcome: 'NEEDS_FIRST_APPROVAL' }
  // The revision is bigger than the approved total plus its tolerance. Work
  // pauses and the driver is asked again.
  | { outcome: 'NEEDS_REAPPROVAL'; allowancePaise: Paise; overBy: Paise }
  // Within tolerance, or cheaper. The existing approval still covers it and
  // work carries on.
  | { outcome: 'COVERED'; allowancePaise: Paise };

export function reapprovalDecision(query: ReapprovalQuery): ReapprovalDecision {
  if (query.approvedTotalPaise === null) return { outcome: 'NEEDS_FIRST_APPROVAL' };

  // Rounded to whole paise like every other money calculation, and rounded
  // DOWN: an allowance is a limit, and rounding a limit up would let a
  // revision through on the strength of a fraction of a paise.
  const allowancePaise =
    query.approvedTotalPaise +
    Math.floor((query.approvedTotalPaise * query.toleranceBps) / 10_000);

  if (query.revisedTotalPaise <= allowancePaise) {
    return { outcome: 'COVERED', allowancePaise };
  }

  return {
    outcome: 'NEEDS_REAPPROVAL',
    allowancePaise,
    overBy: query.revisedTotalPaise - allowancePaise,
  };
}
