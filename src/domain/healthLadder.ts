// THE DEGRADATION LADDER — what can be broken, what happens when it is, and
// what the system as a whole is then called.
//
// INVARIANT 8 IN ONE FILE. Every entry below names a component, the fallback
// that takes over when it fails, and the words an operator reads. A degraded
// state that is not in this table cannot be rendered, which is the mechanism
// that stops one being added silently.
//
// THE LADDER IS NOT A SEVERITY SCALE, it is a description of what still works:
//   NORMAL    everything is doing its own job.
//   DEGRADED  something is doing a SIMPLER job instead. Dispatch decisions are
//             still made by the system, and are still correct — they are made
//             with less information, or delivered by a worse channel.
//   CRITICAL  the system is no longer deciding. A person is, through a defined
//             manual workflow, and every write is still audited.
//
// THAT LAST LINE IS THE WHOLE POINT OF CRITICAL. It is a mode, not a crash. A
// crashed dispatcher has no queue, no audit trail and no way to send anybody;
// a CRITICAL one shows the dispatcher the queue and lets them assign by hand.
//
// PURE. No database, no clock, no network — this file is a table and two
// functions over it, so the rules can be argued with in a test.

import type { HealthState } from '@prisma/client';

export const HEALTH_COMPONENTS = [
  'AI_EXTRACTION',
  'GPS',
  'WEBSOCKET',
  'SOLVER',
  'PAYMENTS',
  'CREW_ON_SHIFT',
  'DISPATCH_CORE',
] as const;

export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export type LadderEntry = {
  component: HealthComponent;
  // What an operator calls this thing. Never the enum.
  label: string;
  // What takes over when it is down. This is the sentence that goes in the
  // banner, so it is written for a person under pressure: what still works,
  // not what broke.
  fallback: string;
  // Whether this component failing takes the SYSTEM to DEGRADED or all the way
  // to CRITICAL. Only one component can do the latter, and it is the one that
  // decides where technicians go.
  worstCase: Extract<HealthState, 'DEGRADED' | 'CRITICAL'>;
  // CAN A JOB STILL BE DISPATCHED WHILE THIS IS DEGRADED?
  //
  // The banner used to end every degraded sentence with "Dispatch decisions
  // are unaffected", which was true of all five components that existed when
  // it was written — a model, a map, a socket, a deadline and a payment rail,
  // none of which stand between a job and a van. CREW_ON_SHIFT is the first
  // one that does, and a banner asserting dispatch is fine while nothing can
  // be dispatched is the same failure §15 already records twice: a fallback
  // describing a world the operator is not in.
  //
  // A field rather than a special case, so the next component added has to
  // answer the question rather than inherit an answer.
  dispatchContinues: boolean;
};

const LADDER: Record<HealthComponent, LadderEntry> = {
  AI_EXTRACTION: {
    component: 'AI_EXTRACTION',
    label: 'Symptom assistant',
    fallback: 'Drivers answer the structured symptom picker instead. Dispatch is unaffected.',
    dispatchContinues: true,
    worstCase: 'DEGRADED',
  },
  GPS: {
    component: 'GPS',
    label: 'Vehicle positions',
    // Precisely what exists, not what sounds good: the manual path is a
    // dispatcher CONFIRMING a corrected position that came from the driver
    // (src/commit/eventPromotions.ts), not typing coordinates into a box.
    // A fallback sentence promising a screen that does not exist would be a
    // silent degraded state wearing a banner.
    fallback: "Last known position is used and flagged; a dispatcher can confirm a corrected one from the driver's chat.",
    dispatchContinues: true,
    worstCase: 'DEGRADED',
  },
  WEBSOCKET: {
    component: 'WEBSOCKET',
    label: 'Live updates',
    fallback: 'Consoles poll every few seconds instead of receiving pushes.',
    dispatchContinues: true,
    worstCase: 'DEGRADED',
  },
  SOLVER: {
    component: 'SOLVER',
    label: 'Planner',
    fallback: 'The best plan found before the deadline is used, flagged as incomplete.',
    dispatchContinues: true,
    worstCase: 'DEGRADED',
  },
  PAYMENTS: {
    component: 'PAYMENTS',
    label: 'Payments',
    fallback: 'Authorisations are marked pending and retried. Dispatch is never blocked.',
    dispatchContinues: true,
    worstCase: 'DEGRADED',
  },
  // NOT AN OUTAGE — A STAFFING GAP, and the ladder has never had a word for
  // one. Every other component here reports something BROKEN; this reports the
  // system working perfectly with nobody to work with, which produces an
  // identically empty board and, until now, an identically silent screen.
  //
  // It earned its place the hard way. A walkthrough was run against a fleet
  // where one of thirty-one technicians was on shift: every job came back
  // NO_TECHNICIAN_ON_SHIFT, the queue looked completely normal, and an evening
  // went into concluding that the dispatch path was broken. Nothing on any
  // screen said the fleet was off duty. The per-job escalation card
  // (ESCALATE_NO_FEASIBLE_PLAN) now says it per job; this says it once, at the
  // top, before a dispatcher has clicked anything.
  //
  // DEGRADED, NOT CRITICAL, and the distinction is the ladder's own: CRITICAL
  // means the system has stopped deciding. Here it is deciding correctly and
  // there is nobody to decide about. DISPATCH_CORE stays the only component
  // that can go critical.
  CREW_ON_SHIFT: {
    component: 'CREW_ON_SHIFT',
    label: 'Crew on shift',
    fallback: 'Jobs keep queueing and stay ranked. Nothing can be dispatched until crew come on duty — check the on-call roster.',
    dispatchContinues: false,
    worstCase: 'DEGRADED',
  },
  DISPATCH_CORE: {
    component: 'DISPATCH_CORE',
    label: 'Automatic dispatch',
    // WHAT ACTUALLY HAPPENS, not what would be nice. This sentence used to
    // promise "assignments are made by hand", and the screen for doing that
    // does not exist — the per-row unit dropdown was deliberately removed at
    // Phase 9, and Phase 22b's audit found the promise still standing. A
    // fallback describing a workflow an operator cannot reach is a silent
    // degraded state wearing a banner, which is the exact failure the GPS entry
    // above was already corrected for.
    //
    // The manual workflow is CUT rather than pending (see DECISIONS.log). So
    // this now says the two true things: the queue does not disappear, and the
    // outage is what an operator is waiting on.
    fallback: 'The priority queue stays visible and every write is still audited. New assignments resume automatically when dispatch recovers.',
    dispatchContinues: false,
    worstCase: 'CRITICAL',
  },
};

export function ladderEntry(component: HealthComponent): LadderEntry {
  return LADDER[component];
}

export function isHealthComponent(value: string): value is HealthComponent {
  return (HEALTH_COMPONENTS as readonly string[]).includes(value);
}

export type ComponentReading = {
  component: HealthComponent;
  state: HealthState;
  detail: string | null;
};

// THE ROLL-UP. One CRITICAL component makes the system CRITICAL; any DEGRADED
// one makes it DEGRADED; otherwise NORMAL.
//
// A component is never allowed to report a state worse than its ladder entry
// says it can cause: a broken symptom assistant is a DEGRADED intake and can
// never be a CRITICAL system, because drivers still get help. Clamping here
// rather than trusting the probe means one careless probe cannot black out the
// console.
export function systemMode(readings: ComponentReading[]): HealthState {
  let mode: HealthState = 'NORMAL';

  for (const reading of readings) {
    const capped = clamp(reading);
    if (capped === 'CRITICAL') return 'CRITICAL';
    if (capped === 'DEGRADED') mode = 'DEGRADED';
  }

  return mode;
}

function clamp(reading: ComponentReading): HealthState {
  if (reading.state === 'NORMAL') return 'NORMAL';
  if (reading.state === 'CRITICAL' && LADDER[reading.component].worstCase === 'DEGRADED') {
    return 'DEGRADED';
  }
  return reading.state;
}

// The banner, as a sentence an operator reads rather than a list of enums.
// Built here rather than in the browser for the same reason the driver's panel
// is worded on the server: a second translation table in JavaScript is a
// second place for SCREAMING_CASE to leak out.
export function describeMode(mode: HealthState, degraded: ComponentReading[]): string {
  if (mode === 'NORMAL') return 'All systems normal.';

  const entries = degraded.map((reading) => ladderEntry(reading.component));
  const names = entries.map((entry) => entry.label).join(', ');

  if (mode === 'CRITICAL') {
    return `Automatic dispatch is down (${names}). ${ladderEntry('DISPATCH_CORE').fallback}`;
  }
  // The tail is read off the components rather than asserted. With a model or
  // a socket down, dispatch genuinely carries on and saying so is the reassuring
  // half of the sentence; with no crew on shift it does not, and the operator
  // needs that in the headline rather than three lines further down.
  const blocked = entries.filter((entry) => !entry.dispatchContinues);
  if (blocked.length === 0) {
    return `Running degraded: ${names}. Dispatch decisions are unaffected.`;
  }
  return `Running degraded: ${names}. Nothing can be dispatched until this clears.`;
}
