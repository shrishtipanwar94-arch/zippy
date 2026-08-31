// WHO CONFIRMS WHAT, AND WHAT THEY ARE ASKED.
//
// A flagged message becomes operational state only when a person says so. This
// file is the whole answer to which person, and it is a policy table rather
// than an if-statement in a route for the same reason permissions.ts is: the
// question "who can turn a chat message into a dispatch change?" has to be
// answerable by reading one thing.
//
// THE ROUTING IS THE INTERESTING PART. It is not "operators approve things and
// customers do not" — for a SAFETY change the driver is the ONLY correct
// confirmer:
//
//   The driver is the only person who can see whether they are blocking
//   traffic. A dispatcher confirming it is guessing from a chat message, and
//   they are three minutes and a queue away. Those three minutes are the whole
//   reason the escalation exists.
//
// For location and access it is the reverse. "There's a divider between me and
// the technician" is a claim about the road network, and the technician driving
// it — or the dispatcher looking at the map — is better placed to judge it than
// the person sitting in the broken-down car.
//
// PURE. No database, no clock.

import type { PromotionKind, Role } from '@prisma/client';

// Two confirmer groups, not four roles. DRIVER is one person; OPERATOR is
// "whoever is working this job" — the assigned technician, or a dispatcher.
// Keeping it at two means a promotion kind never has to name a role list.
export type Confirmer = 'DRIVER' | 'OPERATOR';

const CONFIRMER: Record<PromotionKind, Confirmer> = {
  // One tap, by the person who can actually see the traffic.
  SAFETY_CHANGE: 'DRIVER',
  // A claim about the road, judged by whoever is driving it.
  LOCATION_CORRECTION: 'OPERATOR',
  ACCESS_RESTRICTION: 'OPERATOR',
  // Detail for the person holding the spanner.
  DIAGNOSIS_DETAIL: 'OPERATOR',
};

const OPERATOR_ROLES: ReadonlySet<Role> = new Set(['TECHNICIAN', 'DISPATCHER']);

export function confirmerFor(kind: PromotionKind): Confirmer {
  return CONFIRMER[kind];
}

export function mayConfirm(kind: PromotionKind, role: Role): boolean {
  return confirmerFor(kind) === 'DRIVER' ? role === 'DRIVER' : OPERATOR_ROLES.has(role);
}

// ---------------------------------------------------------------------------
// WHAT THE PERSON IS ASKED.
//
// The driver's safety question is quoted from the brief almost verbatim, and
// the second line is doing real work: it tells the driver what saying yes
// COSTS them, which is nothing, and what it buys, which is speed. A
// confirmation dialog that does not say what it will do is a dialog people
// learn to dismiss.

export type ConfirmationPrompt = {
  question: string;
  // Why this is being asked at all. Shown under the question.
  because: string;
  yes: string;
  no: string;
};

const PROMPTS: Record<PromotionKind, ConfirmationPrompt> = {
  SAFETY_CHANGE: {
    question: 'Are you blocking moving traffic?',
    because:
      'This changes how we prioritise your job — we will send whoever can reach you fastest.',
    yes: 'Yes',
    no: 'No',
  },
  LOCATION_CORRECTION: {
    question: 'Update where this job is dispatched to?',
    because: 'The driver may have corrected their position. Confirm only if this looks right.',
    yes: 'Update the location',
    no: 'Ignore',
  },
  ACCESS_RESTRICTION: {
    question: 'Record an access restriction on this job?',
    because: 'This is visible to whoever is driving out, before they arrive.',
    yes: 'Record it',
    no: 'Ignore',
  },
  DIAGNOSIS_DETAIL: {
    question: 'Add this to the job notes?',
    because:
      'It does not change the fault the system is planning for — only an on-site diagnosis does that.',
    yes: 'Add the note',
    no: 'Ignore',
  },
};

export function promptFor(kind: PromotionKind): ConfirmationPrompt {
  return PROMPTS[kind];
}

// ---------------------------------------------------------------------------
// SAFETY ONLY ESCALATES, NEVER DE-ESCALATES.
//
// A confirmed SAFETY_CHANGE can raise a job to HIGH_RISK. Nothing in this path
// can lower it, and the asymmetry is deliberate. The original level came from
// triage over facts the driver stated at intake (src/domain/safety.ts); a later
// chat message saying "actually it's fine now" is exactly the input we should
// be least willing to act on, because the cost of believing it wrongly is a
// person on a live carriageway ranked as routine. Lowering a safety level stays
// an operator decision made against the job, not a chat confirmation.
export function escalatedSafetyLevel(current: string): 'HIGH_RISK' | null {
  return current === 'HIGH_RISK' ? null : 'HIGH_RISK';
}
