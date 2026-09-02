// THE TECHNICIAN'S EVENT FEED — the same JobEvent stream, in their language.
//
// WHY THIS IS NOT `driverUpdates.ts`, and not the dispatcher's timeline either.
// All three read the same append-only stream and want three different things:
//
//   DISPATCHER   every event, with its type and its payload. It is the audit
//                trail, and an operator quoting `CAPABILITY_MISSING` back at
//                you knows more than a sentence would tell them.
//   DRIVER       reassurance, and nothing that looks like a database. No event
//                type, no payload, no ids (src/domain/driverUpdates.ts).
//   TECHNICIAN   what happened to THEIR job, in the second person, including
//                the things a driver is never told — that a re-plan took the
//                job off them, that a diagnosis they filed moved it.
//
// Until Phase 22b's audit the technician's page rendered the DISPATCHER's
// panel: SCREAMING_CASE event types, ISO timestamps and raw JSON payloads, on a
// phone, in daylight, under the heading "What has happened on this job". That
// is the whole reason this file exists.
//
// A WHITELIST, NOT A FORMATTER WITH A FALLBACK — the same rule the driver's
// feed follows and for the same reason. An event type nobody has written a
// sentence for produces nothing rather than leaking its name onto the screen.
// The failure mode of forgetting is a quieter feed, which is safe.

const SENTENCES: Record<string, string> = {
  DISPATCH_COMMITTED: 'This job was assigned to you.',
  TECHNICIAN_OFFER_ACCEPTED: 'You accepted this job.',
  TECHNICIAN_EN_ROUTE: 'You set off.',
  TECHNICIAN_ARRIVED: 'You arrived on scene.',
  TECHNICIAN_DIAGNOSING: 'You started diagnosing.',
  TECHNICIAN_WORKING: 'You started work.',
  DIAGNOSIS_CHANGED: 'You filed a new diagnosis. The system re-planned the job.',
  ESTIMATE_ISSUED: 'You sent the driver a cost. Work pauses until they answer.',
  ESTIMATE_APPROVED: 'The driver approved the cost. You can carry on.',
  ESTIMATE_DECLINED: 'The driver declined the extra work. Finish what was already agreed.',
  PARTS_DECLARED: 'You recorded the parts you fitted.',
  // THE ONE THE AUDIT WAS ABOUT. A re-plan that takes the job off a technician
  // wrote this event from Phase 13 and nothing ever showed it to them — their
  // board simply went empty. It is deliberately blunt: somebody standing at a
  // roadside needs to know they can stand down.
  TECHNICIAN_RELEASED_FROM_JOB: 'This job was reassigned. You are released — you can stand down.',
  TECHNICIAN_RELEASED_AFTER_ACCEPT: 'This job was reassigned before you set off. You are released.',
  DISPATCH_REQUEUED: 'The system is re-planning this job.',
  JOB_COMPLETION_VERIFIED: 'The driver confirmed the work. This job is complete.',
  PAYMENT_CAPTURED: 'The callout and approved work were charged to the driver.',
  CALLOUT_AUTHORISED: 'The driver’s callout fee was authorised.',
  PAYMENT_AUTHORISATION_PENDING: 'The driver’s card could not be authorised yet. This does not affect your work.',
  JOB_CANCELLED: 'This job was cancelled.',
};

export type TechnicianUpdate = {
  at: string;
  text: string;
};

export function technicianUpdatesFor(
  events: { eventType: string; at: Date }[],
): TechnicianUpdate[] {
  const updates: TechnicianUpdate[] = [];
  for (const event of events) {
    const text = SENTENCES[event.eventType];
    if (!text) continue;
    updates.push({ at: event.at.toISOString(), text });
  }
  return updates;
}

// Was this technician taken off a job? Read from the same whitelist so the
// wording cannot drift from the feed's, and returned separately because it is
// not a line in a list — it is the one thing on the screen that needs to
// interrupt somebody.
export const RELEASE_EVENTS = [
  'TECHNICIAN_RELEASED_FROM_JOB',
  'TECHNICIAN_RELEASED_AFTER_ACCEPT',
] as const;

export function releaseSentenceFor(eventType: string): string | null {
  return SENTENCES[eventType] ?? null;
}
