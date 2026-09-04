// WHAT WE SAY TO THE DRIVER — the translation map, and nothing else.
//
// A driver on a roadside at night is the least technical reader this system
// has, and they are reading it under stress. docs/UI.md is explicit: status is
// a sentence, not a badge, and no enum ever reaches this surface. That rule is
// only enforceable if there is exactly ONE place a JobStatus becomes English,
// and this is it. Every driver-facing string in the product comes from here or
// from driverUpdates.ts; nothing in /public writes a status sentence of its
// own.
//
// This runs on the SERVER rather than in the browser on purpose. Translating
// here means "no enum reaches a driver" is a property of the API response, so
// a test can assert it (tests/driverView.test.ts scans the whole body for
// SCREAMING_CASE) instead of a reviewer having to read every template.
//
// ZERO NEW BACKEND, as the phase brief requires. Nothing here queries, writes
// or decides anything — it is a pure function from state the system already
// records to a sentence.

import type { JobStatus, SafetyLevel, UnitKind } from '@prisma/client';
import type { FaultCode } from './faults.js';

// Bengaluru is UTC+5:30 with no daylight saving, so a fixed offset is correct
// rather than merely convenient — the same constant safety.ts reasons about
// night with.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

// A clock time in IST. Still used where an absolute instant is the right thing
// to show; the driver's arrival line is not one of those — see below.
export function formatIstClock(at: Date): string {
  const local = new Date(at.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// HOW LONG, NOT WHAT TIME.
//
// This screen showed "arriving 00:44". Reading a 24-hour clock and subtracting
// the current time from it is a skill, and this is a product for someone
// standing at the side of a road, possibly at night, possibly not a confident
// reader — "about 12 minutes" is the same fact with the arithmetic already
// done.
//
// THIS IS NOT THE COUNTDOWN THE BRIEF RULES OUT. The objection there was to a
// fake countdown that ticks down in the browser and stalls at "2 minutes" for
// a quarter of an hour, which reads as a broken promise. This number is
// computed once per response from the real recorded estimate and only changes
// when a new estimate is recorded — it is relative phrasing of a real figure,
// not a timer.
//
// Rounded to five minutes above ten, because a roadside ETA is not accurate to
// the minute and printing "about 23 minutes" claims a precision the routing
// engine does not have.
export function formatArrivalIn(arrivingAt: Date, now: Date): string {
  const minutes = Math.round((arrivingAt.getTime() - now.getTime()) / 60_000);

  if (minutes <= 1) return 'Any moment now';
  if (minutes < 10) return `About ${minutes} minutes`;
  if (minutes < 60) return `About ${Math.round(minutes / 5) * 5} minutes`;

  const hours = Math.round(minutes / 30) / 2;
  return hours === 1 ? 'About an hour' : `About ${hours} hours`;
}

export type NarrativeContext = {
  status: JobStatus;
  // The first name we show. Null before anyone is assigned.
  helperName: string | null;
  // When they are expected, from the latest recorded estimate. Null when we
  // have no honest number — and we then say nothing about time at all rather
  // than inventing one.
  arrivingAt: Date | null;
  // True while a re-plan is in flight: the technician found something the
  // assigned crew cannot resolve and a dispatcher is arranging different help.
  // Not a JobStatus — the system records it as an open action request — but it
  // is the single most alarming thing that can happen to a driver mid-job, so
  // it gets its own sentence rather than being hidden behind the old status.
  replanning: boolean;
  // True when the crew on the way is diverting to collect a part they do not
  // have on board — the PART_SOURCING branch, from the dispatch option the
  // solver actually chose. Like `replanning` this is not a JobStatus, and like
  // `replanning` it is the kind of thing a driver notices as an unexplained
  // delay if nobody says it out loud. Saying it is also what stops the phrase
  // "has the skills but needs a part" being an internal detail: it is the
  // difference between waiting for the right person and waiting for nothing.
  sourcingPart: boolean;
  // Whether intake finished asking questions. Also not a JobStatus: a job sits
  // at INTAKE from the last answer until the solver plans it, and during that
  // window "we are taking down the details" is stale — the browser
  // walk-through caught it sitting above a feed line already saying we had
  // everything we needed. Read from the INTAKE_COMPLETED event the route was
  // already fetching, so this stays zero new backend.
  intakeComplete: boolean;
};

// The statuses during which a part run is still ahead of the driver rather
// than behind them. Once the crew is on site the detour is history and the
// sentence would be a distraction.
const STILL_ON_THE_WAY: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'PLANNED',
  'OFFERED',
  'COMMITTED',
  'EN_ROUTE',
]);

export function headlineFor(context: NarrativeContext): string {
  if (context.replanning) return replanningSentence(context.helperName);
  if (context.sourcingPart && STILL_ON_THE_WAY.has(context.status)) {
    return partSourcingSentence(context.helperName);
  }

  const who = context.helperName ?? 'Your technician';

  switch (context.status) {
    case 'DRAFT':
    case 'INTAKE':
      return context.intakeComplete
        ? 'Finding someone equipped for this.'
        : 'We are taking down the details of your breakdown.';
    // THREE STAGES OF "NOBODY IS ASSIGNED YET", AND THEY ARE NOT THE SAME NEWS.
    // These shared one sentence with intake-complete until Phase 22b's audit,
    // which made the driver's screen look frozen through the most anxious part
    // of the wait: the phase brief asks for six distinct states and this was
    // three of them wearing one. PLANNED means the solver has picked a crew and
    // nobody has been asked yet; OFFERED means somebody has been asked and has
    // forty-five seconds to answer. Both are progress, and saying so is the
    // whole job of this screen.
    case 'PLANNED':
      return 'We have found a crew for this and are contacting them now.';
    case 'OFFERED':
      return 'We have asked a technician to come. Waiting for them to confirm.';
    // NO TIME IN THIS SENTENCE. The arrival figure is the biggest thing on the
    // card directly underneath, and it was being said twice — once buried in
    // this headline and once as a large line below it. One fact, one place, and
    // the place is the one where it is a number rather than a clause.
    case 'COMMITTED':
    case 'EN_ROUTE':
      return `${who} is on the way.`;
    case 'ON_SITE':
      return `${who} has arrived and is with your vehicle.`;
    case 'DIAGNOSING':
      return `${who} is checking what is wrong.`;
    case 'WORKING':
      return `${who} is working on your vehicle now.`;
    // WORK HAS PAUSED, and the sentence says so plainly rather than leaving a
    // driver to wonder why nothing is happening. It points at the estimate
    // card below it, which is the only thing that can unpause the job.
    case 'AWAITING_APPROVAL':
      return `${who} has worked out what is needed. Please check the cost below before they carry on.`;
    case 'AWAITING_DESTINATION':
      return 'Confirming a workshop that can take your car.';
    case 'TOWING':
      return 'Your car is on its way to the workshop.';
    case 'RESOLVED':
      return `All done. ${who} has finished with your vehicle.`;
    case 'UNSERVICEABLE':
      return 'We have not been able to reach you yet. A dispatcher is looking at this now and will be in touch.';
    case 'CANCELLED':
      return 'This request was cancelled.';
  }
}

function partSourcingSentence(helperName: string | null): string {
  const who = helperName ?? 'Your technician';
  return `${who} has the skills for this but needs a part. We are arranging it now.`;
}

function replanningSentence(helperName: string | null): string {
  const who = helperName ?? 'Your technician';
  return `${who} found the problem is not what we first thought. We are arranging the right help for it now.`;
}

// ---------------------------------------------------------------------------
// WHAT WE THINK IT IS — the sentence the phase brief quotes verbatim:
// "We aren't certain whether it's the battery or the alternator, so we're
//  sending someone equipped for both."
//
// It is honest about uncertainty rather than picking the top fault and
// sounding sure, because the dispatch decision genuinely covers several faults
// (see domain/capabilitySet.ts) and a driver told "it's the battery" who then
// watches a tow truck arrive has been misled by their own status page.

// Plain-language names for the fault catalogue. This is the ONLY place a fault
// code becomes something a driver reads, which is why it lives beside the
// status map rather than in faults.ts — that file is dispatch's vocabulary,
// this file is the driver's.
const FAULT_LABELS: Record<FaultCode, string> = {
  FLAT_BATTERY: 'a flat battery',
  FAILED_BATTERY: 'a battery that needs replacing',
  ALTERNATOR_FAILURE: 'the alternator',
  STARTER_MOTOR: 'the starter motor',
  OUT_OF_FUEL: 'an empty fuel tank',
  FLAT_TYRE: 'a flat tyre',
  KEYS_LOCKED_IN: 'keys locked inside the car',
  KEY_FAILURE: 'a problem with the key',
  ENGINE_OVERHEAT: 'the engine overheating',
  BRAKE_FAILURE: 'a problem with the brakes',
  EV_HV_FAULT: 'the high-voltage battery system',
  IMMOBILISED_UNKNOWN: 'something that cannot be fixed at the roadside',
};

export function labelForFault(fault: FaultCode): string {
  return FAULT_LABELS[fault];
}

// WHAT TO LOOK OUT FOR. The unit's `code` — VAN-KOR-01 — is a fleet asset
// identifier and means nothing to a driver; what they want, standing beside a
// road watching vehicles go past, is what shape of vehicle is coming. The
// codes only ever appear on the dispatcher's console, where they identify an
// asset rather than describe one.
const UNIT_LABELS: Record<UnitKind, string> = {
  VAN: 'a service van',
  BIKE: 'a service bike',
  FLATBED_TOW: 'a flatbed tow truck',
  WHEEL_LIFT_TOW: 'a tow truck',
};

export function labelForUnit(kind: UnitKind): string {
  return UNIT_LABELS[kind];
}

// ---------------------------------------------------------------------------
// THE SAME VOCABULARY, FOR THE OTHER CUSTOMER.
//
// A fleet manager is a customer, not an operator. Their dashboard was rendering
// AWAITING_APPROVAL and HIGH_RISK straight out of the database — the identical
// leak this file was written to close on the driver's screen. The two maps
// below live here, beside FAULT_LABELS and UNIT_LABELS, because this file is
// already the one place a code becomes words for somebody outside the
// business: src/domain/repeatPattern.ts has imported `labelForFault` for the
// fleet dashboard's own flag since Phase 21. A second map in the browser would
// be a second place for an enum to leak.
//
// These are LABELS, not the sentences above — a table cell, not a status hero.
// A dispatcher's console keeps the raw enums, deliberately: an operator quoting
// AWAITING_APPROVAL back at you knows more than "waiting on the driver" would
// tell them.

const STATUS_LABELS: Record<JobStatus, string> = {
  DRAFT: 'Being raised',
  INTAKE: 'Taking details',
  PLANNED: 'Finding a crew',
  OFFERED: 'Finding a crew',
  COMMITTED: 'Crew assigned',
  EN_ROUTE: 'On the way',
  ON_SITE: 'On scene',
  DIAGNOSING: 'Being diagnosed',
  WORKING: 'Being worked on',
  AWAITING_APPROVAL: 'Waiting on the driver',
  AWAITING_DESTINATION: 'Finding a workshop',
  TOWING: 'Being towed',
  RESOLVED: 'Resolved',
  UNSERVICEABLE: 'Needs a dispatcher',
  CANCELLED: 'Cancelled',
};

// Takes a plain string rather than the enum because the fleet read model
// carries these as strings, and the alternative is a cast at every call site.
// The Record above is still exhaustive over JobStatus, so adding a status to
// the schema without wording it here is a compile error — the fallback only
// covers a value the database produced that TypeScript never saw.
// THE FIVE STAGES, AS THE DRIVER SEES THEM.
//
// The technician has had a segmented rung bar since Phase 22b; the driver had
// nothing telling them whether "we are finding someone" was the second step of
// five or the fourth. That is most of what somebody waiting wants to know.
//
// WORDED AND FLAGGED HERE, not in the browser. The whole reason this file
// exists is that the driver's vocabulary is testable — tests/driverSurface.ts
// scans the response for SCREAMING_CASE — so shipping a status key to the phone
// and translating it there would move the one thing that is checked into the
// one place that is not.
//
// A status this table has never heard of returns an empty list, and the phone
// shows no stepper at all: a stepper with nothing highlighted tells a driver
// less than no stepper.
const DRIVER_STAGES: { key: string; label: string }[] = [
  { key: 'reported', label: 'You told us what happened' },
  { key: 'finding', label: 'We are finding someone equipped for it' },
  { key: 'coming', label: 'They are on the way' },
  { key: 'working', label: 'They are with your vehicle' },
  { key: 'done', label: 'Finished' },
];

// Statuses that mean "something is being re-arranged" map to `finding`,
// because that is what is happening from the driver's side of it.
const STAGE_FOR_STATUS: Record<string, string> = {
  DRAFT: 'reported',
  INTAKE: 'reported',
  PLANNED: 'finding',
  OFFERED: 'finding',
  AWAITING_DESTINATION: 'finding',
  COMMITTED: 'coming',
  EN_ROUTE: 'coming',
  TOWING: 'coming',
  ON_SITE: 'working',
  DIAGNOSING: 'working',
  WORKING: 'working',
  AWAITING_APPROVAL: 'working',
  RESOLVED: 'done',
};

export function stagesFor(status: string): { label: string; state: string }[] {
  const stage = STAGE_FOR_STATUS[status];
  if (!stage) return [];

  const current = DRIVER_STAGES.findIndex((entry) => entry.key === stage);
  return DRIVER_STAGES.map((entry, index) => ({
    label: entry.label,
    state: index < current ? 'done' : index === current ? 'current' : 'todo',
  }));
}

export function labelForJobStatus(status: string): string {
  return STATUS_LABELS[status as JobStatus] ?? status;
}

const SAFETY_LABELS: Record<SafetyLevel, string> = {
  NORMAL: 'Normal',
  ELEVATED: 'Elevated',
  HIGH_RISK: 'High risk',
};

export function labelForSafetyLevel(level: string): string {
  return SAFETY_LABELS[level as SafetyLevel] ?? level;
}

// `contenders` is what capabilitySet.contendingFaults() returned — the faults
// still seriously in play, most likely first. The sentence changes shape with
// how many there are, because "we aren't certain whether it's X" with one
// option is not a sentence anybody writes.
export function whatWeThinkItIs(contenders: FaultCode[]): string {
  if (contenders.length === 0) return 'We are still working out what is wrong.';

  const labels = contenders.map(labelForFault);

  if (labels.length === 1) {
    return `We think it is ${labels[0]}, and we are sending someone equipped for that.`;
  }
  if (labels.length === 2) {
    return `We are not certain whether it is ${labels[0]} or ${labels[1]}, so we are sending someone equipped for both.`;
  }

  const last = labels[labels.length - 1];
  const rest = labels.slice(0, -1).join(', ');
  return `We are not certain yet — it could be ${rest} or ${last} — so we are sending someone equipped for all of them.`;
}
