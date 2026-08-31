// WHICH ACTIONS THE SYSTEM MAY TAKE ALONE, AS A TABLE.
//
// The same shape as src/auth/permissions.ts, for the same reason: "may this
// happen without a human?" is a policy question, and a policy scattered
// through if-statements in the code that happens to notice each situation is
// a policy nobody can read. One table, one lookup, and adding an action means
// choosing its tier deliberately rather than defaulting to whatever the
// surrounding function already does.
//
// THE THREE TIERS, and the line between them:
//   AUTO       execute immediately and log it. Reserved for actions where a
//              human reviewing it would always say yes and would resent being
//              asked — telling a driver their ETA moved, releasing a hold
//              that has already expired.
//   RECOMMEND  the system works out what it would do, with reason and impact,
//              and a dispatcher clicks execute. The default for anything that
//              changes who is going to a job.
//   APPROVE    blocked pending sign-off, approver recorded. For decisions that
//              are commercial, or that admit a promise has already been
//              broken.
//
// THE RULE THE BUILD PLAN STATES AND THIS TABLE ENFORCES: do not let an AUTO
// action do anything a human would want to review. When in doubt the answer is
// RECOMMEND — an unnecessary click costs seconds, and an unreviewed
// reassignment costs a technician driving to the wrong place.

import type { ActionTier } from '@prisma/client';

export const ACTION_KINDS = [
  // AUTO — nobody wants to be asked.
  'NOTIFY_ETA_CHANGED',
  'RELEASE_EXPIRED_HOLD',
  'NOTIFY_DIAGNOSIS_CONFIRMED',

  // RECOMMEND — changes who is going, so a dispatcher sees it first.
  'REASSIGN_AFTER_DIAGNOSIS_CHANGE',
  'REASSIGN_AFTER_TRIGGER',
  'RELEASE_TECHNICIAN_NO_LONGER_NEEDED',

  // APPROVE — commercial, or an admission that something has already failed.
  'ESCALATE_THRASHING_JOB',
  'ESCALATE_SLA_WINDOW_CLOSED',
  'CANCEL_JOB',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

const TIERS: Record<ActionKind, ActionTier> = {
  NOTIFY_ETA_CHANGED: 'AUTO',
  RELEASE_EXPIRED_HOLD: 'AUTO',
  NOTIFY_DIAGNOSIS_CONFIRMED: 'AUTO',

  REASSIGN_AFTER_DIAGNOSIS_CHANGE: 'RECOMMEND',
  REASSIGN_AFTER_TRIGGER: 'RECOMMEND',
  RELEASE_TECHNICIAN_NO_LONGER_NEEDED: 'RECOMMEND',

  ESCALATE_THRASHING_JOB: 'APPROVE',
  // A job whose SLA window closed while it queued. APPROVE rather than
  // RECOMMEND because the decision is commercial — serve it late, re-contract
  // the window, escalate to a partner, or cancel with the customer told — and
  // nothing in the engine has the standing to make it. AUTO would be the
  // clearest possible example of the rule above: silently relaxing a
  // contracted deadline is exactly what a human would want to review.
  ESCALATE_SLA_WINDOW_CLOSED: 'APPROVE',
  CANCEL_JOB: 'APPROVE',
};

export function tierFor(kind: ActionKind): ActionTier {
  return TIERS[kind];
}

// An AUTO action runs the moment it is requested. Everything else waits for a
// person, which is the whole distinction.
export function executesImmediately(kind: ActionKind): boolean {
  return tierFor(kind) === 'AUTO';
}
