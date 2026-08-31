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

import type { JobStatus, UnitKind } from '@prisma/client';
import type { FaultCode } from './faults.js';

// Bengaluru is UTC+5:30 with no daylight saving, so a fixed offset is correct
// rather than merely convenient — the same constant safety.ts reasons about
// night with.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

// "arriving 21:24" — a clock time, never a countdown. The phase brief is
// emphatic about this and the reason is human rather than technical: a
// countdown that stalls at "2 minutes" for a quarter of an hour reads as a
// broken promise, while a clock time that moves reads as new information.
export function formatIstClock(at: Date): string {
  const local = new Date(at.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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
  // Whether intake finished asking questions. Also not a JobStatus: a job sits
  // at INTAKE from the last answer until the solver plans it, and during that
  // window "we are taking down the details" is stale — the browser
  // walk-through caught it sitting above a feed line already saying we had
  // everything we needed. Read from the INTAKE_COMPLETED event the route was
  // already fetching, so this stays zero new backend.
  intakeComplete: boolean;
};

export function headlineFor(context: NarrativeContext): string {
  if (context.replanning) return replanningSentence(context.helperName);

  const who = context.helperName ?? 'Your technician';

  switch (context.status) {
    case 'DRAFT':
    case 'INTAKE':
      return context.intakeComplete
        ? 'Finding someone equipped for this.'
        : 'We are taking down the details of your breakdown.';
    case 'PLANNED':
    case 'OFFERED':
      return 'Finding someone equipped for this.';
    case 'COMMITTED':
    case 'EN_ROUTE':
      return context.arrivingAt
        ? `${who} is on the way, arriving ${formatIstClock(context.arrivingAt)}.`
        : `${who} is on the way to you now.`;
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
