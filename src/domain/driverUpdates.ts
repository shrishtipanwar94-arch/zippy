// THE DRIVER'S LIVE FEED — job events, translated, with a whitelist.
//
// The dispatcher's timeline shows every JobEvent with its type and payload,
// because that is the audit trail. The driver gets the same underlying stream
// and must never see any of that: no event type, no payload, no ids.
//
// A WHITELIST, NOT A FORMATTER WITH A FALLBACK. Any event type without an
// entry here produces nothing and is dropped from the feed. That is the point:
// a later phase adding a new event type cannot leak SCREAMING_CASE onto this
// surface by forgetting to write a sentence for it. The failure mode of
// forgetting is a quieter feed, which is safe; the failure mode of a
// `default:` branch echoing the event type is a driver reading
// `DISPATCH_REQUEUED`, which is the exact bug the phase check looks for.

const SENTENCES: Record<string, string> = {
  JOB_CREATED: 'We received your breakdown report.',
  SYMPTOMS_CAPTURED: 'We noted what is happening with your vehicle.',
  SAFETY_TRIAGED: 'We checked how urgent and how risky your situation is.',
  LOCATION_CAPTURED: 'We noted where you are.',
  INTAKE_COMPLETED: 'We have everything we need to send help.',
  TECHNICIAN_OFFER_SENT: 'We found someone equipped for this and asked them to come.',
  TECHNICIAN_OFFER_ACCEPTED: 'They accepted and are getting ready to set off.',
  DISPATCH_COMMITTED: 'Your technician is confirmed and on the way.',
  ETA_UPDATED: 'We updated your arrival time.',
  TECHNICIAN_EN_ROUTE: 'Your technician has set off.',
  TECHNICIAN_ARRIVED: 'Your technician has arrived.',
  TECHNICIAN_DIAGNOSING: 'Your technician is checking what is wrong.',
  TECHNICIAN_WORKING: 'Your technician has started work.',
  DIAGNOSIS_CHANGED: 'Your technician has taken a closer look and updated what they think is wrong.',
  // A re-plan reads as reassurance rather than alarm on purpose: from the
  // driver's side the fact that matters is that somebody is still coming.
  DISPATCH_REQUEUED: 'We are arranging different help for you.',
  TECHNICIAN_RELEASED_AFTER_ACCEPT: 'We are arranging different help for you.',
  JOB_COMPLETION_VERIFIED: 'You confirmed the work was done. This job is complete.',
};

export type DriverUpdate = {
  at: string;
  text: string;
};

export function driverUpdatesFor(
  events: { eventType: string; at: Date }[],
): DriverUpdate[] {
  const updates: DriverUpdate[] = [];
  for (const event of events) {
    const text = SENTENCES[event.eventType];
    if (!text) continue;
    updates.push({ at: event.at.toISOString(), text });
  }
  return updates;
}
