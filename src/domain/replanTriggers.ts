// EVERY REASON THE SYSTEM RE-PLANS, IN ONE PLACE.
//
// The point of one list is that "should this re-solve?" has exactly one
// answer, and it is a value rather than an if-statement somewhere. A trigger
// scattered across the route that noticed it is a trigger nobody can
// enumerate, and the first question anyone asks about a re-dispatching system
// is "what makes it re-dispatch?".
//
// Pure: no Prisma, no clock, no queue. Deciding WHETHER something is a trigger
// is a domain judgement; acting on it is src/commit/redispatch.ts.

import { distanceKm } from './geo.js';

export const REPLAN_TRIGGERS = [
  // The signature one. A technician arrives, opens the bonnet, and the job is
  // not what intake believed.
  'DIAGNOSIS_CHANGED',
  'TECHNICIAN_DECLINED',
  'TECHNICIAN_OFFLINE',
  'UNIT_BREAKDOWN',
  'DESTINATION_DECLINED',
  'DRIVER_MOVED_MATERIALLY',
  'SAFETY_LEVEL_CHANGED',
  // A DRIVER CONFIRMING URGENCY ON A JOB THAT IS ALREADY AT THE TOP LEVEL.
  // Deliberately not SAFETY_LEVEL_CHANGED, because nothing about the job
  // changed and an event that says otherwise is a lie in the timeline. It
  // earns its place on this list anyway: reserving a crew happens in exactly
  // one place — executing a reassignment action — and a safety escalation is
  // the only thing a driver can do that raises one. A job triaged HIGH_RISK at
  // intake has that escalation already spent, so before this existed the most
  // dangerous jobs were the only ones with no route to a crew at all.
  'SAFETY_LEVEL_CONFIRMED',
  'JOB_CANCELLED',
  // INTAKE FINISHED, SO THE JOB IS READY TO DISPATCH. The same gap as the one
  // above, for every job: reserving a crew happens only by executing a
  // reassignment, and nothing raised one for a job nobody had touched since
  // the driver reported it. Fired only in DEMO_MODE today
  // (src/demo/demoDispatch.ts), where the demo needs every reported job to
  // reach a crew; outside it the system behaves exactly as before.
  'INTAKE_COMPLETED',
] as const;

// NO SLA TRIGGER, AND THAT IS NOW A CONCLUSION RATHER THAN A DEFERRAL.
// Phase 10 found that a job whose SLA window closed became permanently
// infeasible and vanished from every plan, and proposed a ninth trigger to
// catch it. Stage 3 fixed it somewhere better: the bug was in the FILTER, not
// in the absence of a trigger. `feasibility.ts` now stops applying the SLA
// deadline once it has passed, so a late job re-enters candidate generation
// on its own and needs no re-plan event at all. What remains is the
// commercial fact that a promise was broken, which is a RECOMMEND action
// raised by a sweep (src/commit/slaEscalation.ts) — not a dispatch decision,
// and not something re-planning would have helped with.

export type ReplanTrigger = (typeof REPLAN_TRIGGERS)[number];

export function isReplanTrigger(value: string): value is ReplanTrigger {
  return (REPLAN_TRIGGERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// "DO NOT RE-SOLVE ON EVERY GPS PING" — the threshold that makes
// DRIVER_MOVED_MATERIALLY mean something.
//
// A phone reports its position every few seconds and each report differs by a
// metre or two of GPS noise. Treating every one as a trigger would re-solve
// the whole board continuously and would be indistinguishable, from the
// outside, from a system stuck in a loop. 250 metres is far enough that the
// nearest unit could genuinely have changed and well past the noise floor of
// a consumer GPS fix. Not a measured figure.
export const MATERIAL_MOVE_METRES = 250;

export function isMaterialMove(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): boolean {
  return distanceKm(from.lat, from.lng, to.lat, to.lng) * 1000 >= MATERIAL_MOVE_METRES;
}

// ---------------------------------------------------------------------------
// THRASH CONTROL: how many times a job may be reassigned before a human is
// asked to look at it.
//
// A job that has been reassigned four times is not being optimised, it is
// oscillating — and the system cannot tell the difference on its own, because
// each individual re-solve was locally correct. Escalating rather than
// continuing is the only honest response: something about this job is wrong in
// a way the solver cannot see.
export const MAX_REASSIGNMENTS_BEFORE_ESCALATION = 3;

export function shouldEscalateForThrash(reassignmentCount: number): boolean {
  return reassignmentCount >= MAX_REASSIGNMENTS_BEFORE_ESCALATION;
}

// A trigger that ends the job rather than re-planning it. Kept here rather
// than as a check at the call site so the list stays the one description of
// what each trigger means.
export function terminatesJob(trigger: ReplanTrigger): boolean {
  return trigger === 'JOB_CANCELLED';
}

// Whether a trigger should actually produce a re-solve. Every trigger in the
// current list does, except the one that ends the job instead.
export function causesResolve(trigger: ReplanTrigger): boolean {
  return !terminatesJob(trigger);
}
