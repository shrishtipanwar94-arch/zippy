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
};

const LADDER: Record<HealthComponent, LadderEntry> = {
  AI_EXTRACTION: {
    component: 'AI_EXTRACTION',
    label: 'Symptom assistant',
    fallback: 'Drivers answer the structured symptom picker instead. Dispatch is unaffected.',
    worstCase: 'DEGRADED',
  },
  GPS: {
    component: 'GPS',
    label: 'Vehicle positions',
    fallback: 'Last known position is used and flagged; a dispatcher can enter one by hand.',
    worstCase: 'DEGRADED',
  },
  WEBSOCKET: {
    component: 'WEBSOCKET',
    label: 'Live updates',
    fallback: 'Consoles poll every few seconds instead of receiving pushes.',
    worstCase: 'DEGRADED',
  },
  SOLVER: {
    component: 'SOLVER',
    label: 'Planner',
    fallback: 'The best plan found before the deadline is used, flagged as incomplete.',
    worstCase: 'DEGRADED',
  },
  PAYMENTS: {
    component: 'PAYMENTS',
    label: 'Payments',
    fallback: 'Authorisations are marked pending and retried. Dispatch is never blocked.',
    worstCase: 'DEGRADED',
  },
  DISPATCH_CORE: {
    component: 'DISPATCH_CORE',
    label: 'Automatic dispatch',
    fallback: 'Manual dispatcher workflow: the queue stays visible and assignments are made by hand. Every write is still audited.',
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
  return `Running degraded: ${names}. Dispatch decisions are unaffected.`;
}
