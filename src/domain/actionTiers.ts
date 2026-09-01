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
  'ESCALATE_SLA_WINDOW_CLOSED',

  // APPROVE — commercial, or an admission that something has already failed.
  'ESCALATE_THRASHING_JOB',
  'CANCEL_JOB',
  'APPROVE_CROSS_TENANT_CONTENTION',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

const TIERS: Record<ActionKind, ActionTier> = {
  NOTIFY_ETA_CHANGED: 'AUTO',
  RELEASE_EXPIRED_HOLD: 'AUTO',
  NOTIFY_DIAGNOSIS_CONFIRMED: 'AUTO',

  REASSIGN_AFTER_DIAGNOSIS_CHANGE: 'RECOMMEND',
  REASSIGN_AFTER_TRIGGER: 'RECOMMEND',
  RELEASE_TECHNICIAN_NO_LONGER_NEEDED: 'RECOMMEND',
  // A job whose SLA window closed while it queued. RECOMMEND, NOT APPROVE,
  // and the reasoning is the whole point: APPROVE blocks pending sign-off,
  // so tiering this decision that way would make a job that is ALREADY late
  // wait even longer — for a human to acknowledge that it is late. That
  // defeats the purpose of noticing.
  //
  // Dispatch is no longer gated on this at all: feasibility stops filtering
  // on a deadline once it has passed, so the job is already competing for a
  // van while this sits in the queue. What the action is FOR is the
  // commercial follow-up — re-contract, credit, escalate to a partner, tell
  // the customer — which is a real decision a human owns but which nobody
  // needs to make before a van moves.
  ESCALATE_SLA_WINDOW_CLOSED: 'RECOMMEND',

  ESCALATE_THRASHING_JOB: 'APPROVE',
  CANCEL_JOB: 'APPROVE',
  // One scarce van, a contract job and a consumer job, the same safety level.
  // APPROVE is the whole point rather than a tier chosen by habit: the system
  // has priced both sides and could pick, and picking is exactly what it must
  // not do. A system that silently decides which paying customer to disappoint
  // is a system nobody deploys — so it writes both numbers down and asks.
  //
  // It blocks, and blocking is the cost. A dispatcher who does not answer
  // leaves one of two people waiting, which is the honest shape of the
  // situation: there was only ever one van.
  APPROVE_CROSS_TENANT_CONTENTION: 'APPROVE',
};

export function tierFor(kind: ActionKind): ActionTier {
  return TIERS[kind];
}

// An AUTO action runs the moment it is requested. Everything else waits for a
// person, which is the whole distinction.
export function executesImmediately(kind: ActionKind): boolean {
  return tierFor(kind) === 'AUTO';
}
