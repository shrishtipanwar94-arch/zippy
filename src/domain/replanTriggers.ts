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
  'JOB_CANCELLED',
] as const;

// DELIBERATELY ABSENT: a trigger for "the SLA window closed while the job was
// still queued". Phase 10 measured the problem it would address — once a job
// passes its promised window, `SLA_UNREACHABLE` rejects every option for it
// forever and it silently stops appearing in any plan — and DECISIONS.log
// carries the proposal. It is not in this list yet because the response is
// the unresolved part, not the detection: an APPROVE-tier action BLOCKS
// pending sign-off, so a job that is already late would then wait longer in
// an approval queue. Whether the right shape is a blocking APPROVE or an AUTO
// relaxation plus a RECOMMEND for the commercial follow-up is a decision, and
// adding a list entry would look like having made it. Phase 13 Stage 2.

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
