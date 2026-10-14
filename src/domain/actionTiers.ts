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
  'ESCALATE_NO_FEASIBLE_PLAN',
  'ESCALATE_DISPATCH_REQUEUED',

  // APPROVE — commercial, or an admission that something has already failed.
  'ESCALATE_THRASHING_JOB',
  'CANCEL_JOB',
  'APPROVE_CROSS_TENANT_CONTENTION',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

// WHAT THE QUEUE SORTS INTO, WHICH IS NOT WHAT THE TIER SORTS INTO.
//
// The tier says how much AUTHORITY the system claims: RECOMMEND is confident,
// APPROVE explicitly refuses to decide. That is the right axis for who signs
// something off and a poor one for working a queue, because both tiers contain
// cards a dispatcher must act on and cards they merely need to know about.
//
// The demo made the cost of conflating them obvious. Fourteen
// ESCALATE_SLA_WINDOW_CLOSED cards — every one RECOMMEND, every one a real
// commercial follow-up, none of them blocking a van — buried the single
// REASSIGN_AFTER_TRIGGER card that was the only thing on the board that would
// actually dispatch anybody. Finding it meant scrolling and squinting. That is
// bad operations design before it is a demo problem: a worklist where the
// urgent item is visually identical to thirteen items that can wait is a
// worklist people stop reading.
//
// THE QUESTION IS "DOES ACTING ON THIS CHANGE WHO IS GOING, OR WHETHER ANYBODY
// IS?" — the same question invariant 4 makes the system ask about safety. An
// SLA window that closed is a promise already broken and a bill to settle; it
// is real work for a person, and it is not this minute's work.
const CHANGES_WHO_IS_GOING: ReadonlySet<ActionKind> = new Set([
  'REASSIGN_AFTER_DIAGNOSIS_CHANGE',
  'REASSIGN_AFTER_TRIGGER',
  'RELEASE_TECHNICIAN_NO_LONGER_NEEDED',
  // Nobody is coming and waiting will not change that, so this is the queue's
  // most urgent shape even though its tier is only RECOMMEND.
  'ESCALATE_NO_FEASIBLE_PLAN',
  // Same shape, different cause: a plan existed and the reservation lost its
  // race, so the job is back on the board with nobody on it.
  'ESCALATE_DISPATCH_REQUEUED',
  'CANCEL_JOB',
  'APPROVE_CROSS_TENANT_CONTENTION',
  'ESCALATE_THRASHING_JOB',
]);

export function needsDecision(kind: ActionKind): boolean {
  return CHANGES_WHO_IS_GOING.has(kind);
}

// The `kind` column is a string, so a row written before a kind was renamed
// would not type as an ActionKind. Narrowing rather than casting means such a
// row is handled deliberately at the call site instead of crashing the queue.
export function isActionKind(value: string): value is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value);
}

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
  // A re-solve that found NOTHING — every option refused, so this job has no
  // crew and will not get one by waiting. It is the trigger for the human
  // escalation card (src/domain/escalationCard.ts), which is where the actual
  // decision is taken; this row exists to put the job on the worklist and to
  // carry the rejection breakdown where somebody can read it without clicking.
  //
  // RECOMMEND, NOT APPROVE, and for a different reason from the SLA one above.
  // APPROVE renders a sign-off button wired to POST /actions/:id/approve, and
  // approving this would do nothing at all — the decision this card is about
  // (external provider, approve anyway, call the driver) is taken on the
  // escalation card through its own route. A button that resolves nothing is
  // worse than no button. Execute here means "I have seen it and I am dealing
  // with it", which is exactly what the SLA card's button already means.
  ESCALATE_NO_FEASIBLE_PLAN: 'RECOMMEND',
  // A SAGA THAT LOST ITS RACE, MADE VISIBLE (invariant 8). `finishAsRequeued`
  // parks the job back at PLANNED with no unit and no technician, and until
  // this card existed that state reached an operator only by accident: the job
  // rejoined the undifferentiated pending pile, ranked below every HIGH_RISK
  // job, and the first thing that actually said anything was
  // ESCALATE_SLA_WINDOW_CLOSED — which fires once the promise is ALREADY
  // broken. A degraded state visible only after it becomes a breach is not
  // visible in any sense the invariant means.
  //
  // RECOMMEND, and Execute means what it means on the two cards above: "I have
  // seen it and I am dealing with it". It deliberately does NOT restart a
  // saga — picking a new crew is a re-solve, which is handleTrigger's job and
  // needs a plan this card does not carry.
  ESCALATE_DISPATCH_REQUEUED: 'RECOMMEND',

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
