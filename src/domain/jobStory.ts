// A JOB'S LIFE AS SENTENCES, from the log that was already being written.
//
// `job_events` is append-only and complete — every state transition writes one
// (CLAUDE.md), which is the expensive part and it was already done. What it was
// not was readable: the console rendered `TECHNICIAN_OFFER_SENT` over a JSON
// blob, so understanding one job meant translating enum names and reading
// payloads in your head.
//
// This turns the same rows into "Offered to tech-07 · Technician accepted".
// Nothing is computed that the log does not already contain, so there is no
// second source of truth and nothing here can disagree with the timeline — it
// IS the timeline, with better words.
//
// WHY NOT REUSE driverUpdates.ts. That file words the same events for the
// DRIVER, and the two audiences want opposite things. A driver is told "We
// found someone equipped for this and asked them to come" — reassurance, no
// ids, no counts. A dispatcher needs the mechanism: which crew, how many
// options, which reason code. Two vocabularies, and collapsing them would make
// one of them wrong.
//
// PURE. No Prisma, no clock, no locale formatting — it takes rows and returns
// sentences, so it is testable without a database and the caller decides how to
// render a time.

export type JobStoryEvent = {
  sequence: number;
  eventType: string;
  payload: unknown;
  at: Date | string;
};

export type JobStoryLine = {
  sequence: number;
  at: string;
  sentence: string;
};

// Reading one field out of a payload whose shape this module does not own.
// Deliberately defensive: a payload that changed shape should cost the sentence
// its detail, never throw inside a panel rendering a whole job.
//
// STRINGS ONLY, and the split from `count` is not fussiness. Every field read
// through here is an id or an enum — a technician id, a safety level, a
// rejection breakdown. A number arriving in one of those is a malformed
// payload, and printing "Triaged 42" would be the sentence confidently
// reporting nonsense rather than admitting it does not know.
function field(payload: unknown, name: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(payload: unknown, name: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return null;
}

// TECHNICIAN_OFFER_SENT becomes "Technician offer sent".
function humanise(eventType: string): string {
  const words = eventType.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// One entry per event type the dispatcher's timeline can show. A function
// rather than a string wherever the payload has something worth saying — the
// reason codes are the difference between "Triaged HIGH_RISK" and a number
// somebody has to go and look up.
const SENTENCES: Record<string, (payload: unknown) => string> = {
  JOB_CREATED: () => 'Reported',
  SYMPTOMS_CAPTURED: () => 'Symptoms taken',
  SAFETY_TRIAGED: (payload) => {
    const level = field(payload, 'level');
    const reasons = count(payload, 'reasonCodes');
    if (!level) return 'Triaged for safety';
    if (!reasons) return `Triaged ${level}`;
    return `Triaged ${level} on ${reasons} risk factor${reasons === 1 ? '' : 's'}`;
  },
  LOCATION_CAPTURED: () => 'Location fixed',
  FAULT_HYPOTHESIS_UPDATED: (payload) => {
    const top = field(payload, 'topFault');
    return top ? `Most likely fault: ${top}` : 'Fault hypothesis updated';
  },
  INTAKE_COMPLETED: () => 'Intake complete, ready to plan',
  PLAN_SELECTED: (payload) => {
    const label = field(payload, 'label');
    return label ? `Dispatcher recorded the ${label} plan` : 'Dispatcher recorded a plan';
  },
  NO_FEASIBLE_PLAN: (payload) => {
    const breakdown = field(payload, 'breakdown');
    return breakdown ? `No crew could take it: ${breakdown}` : 'No crew could take it';
  },
  ACTION_RECOMMEND: (payload) => {
    const kind = field(payload, 'kind');
    return kind ? `System recommended ${humanise(kind)}` : 'System raised a recommendation';
  },
  ACTION_EXECUTED: (payload) => {
    const kind = field(payload, 'kind');
    return kind ? `Dispatcher executed ${humanise(kind)}` : 'Dispatcher executed an action';
  },
  UNIT_HELD: (payload) => {
    const unit = field(payload, 'unitId');
    return unit ? `Van ${unit} held` : 'A van was held';
  },
  TECHNICIAN_OFFER_SENT: (payload) => {
    const technician = field(payload, 'technicianId');
    return technician ? `Offered to ${technician}` : 'Offered to a technician';
  },
  TECHNICIAN_OFFER_ACCEPTED: () => 'Technician accepted',
  TECHNICIAN_OFFER_DECLINED: () => 'Technician declined',
  DISPATCH_COMMITTED: () => 'Dispatch committed, the van is theirs',
  DISPATCH_REQUEUED: (payload) => {
    const reason = field(payload, 'reason');
    return reason ? `Reservation unwound: ${reason}` : 'Reservation unwound, job requeued';
  },
  SAFETY_LEVEL_CHANGED: (payload) => {
    const from = field(payload, 'from');
    const to = field(payload, 'to');
    return from && to ? `Driver escalated it ${from} to ${to}` : 'Safety level changed';
  },
  SAFETY_LEVEL_CONFIRMED: () => 'Driver confirmed it, already at the top level',
  ETA_UPDATED: () => 'Arrival time updated',
  TECHNICIAN_EN_ROUTE: () => 'Technician set off',
  TECHNICIAN_ARRIVED: () => 'Technician arrived',
  TECHNICIAN_DIAGNOSING: () => 'Technician diagnosing',
  TECHNICIAN_WORKING: () => 'Work started',
  DIAGNOSIS_CHANGED: (payload) => {
    const to = field(payload, 'to') ?? field(payload, 'fault');
    return to ? `Diagnosis changed on site to ${to}` : 'Diagnosis changed on site';
  },
  JOB_RESOLVED: () => 'Resolved',
  JOB_CANCELLED: () => 'Cancelled',
  ESTIMATE_ISSUED: () => 'Estimate sent to the driver',
  ESTIMATE_APPROVED: () => 'Driver approved the estimate',
  ESTIMATE_DECLINED: () => 'Driver declined the extra work',
  SLA_WINDOW_CLOSED_WHILE_QUEUED: () => 'SLA window closed while it was still queued',
  // The demo time control, on the timeline on purpose: it is why a job's age
  // stops matching its event times, and an unexplained gap looks like a bug.
  DEMO_TIME_ADVANCED: (payload) => {
    const minutes = count(payload, 'minutes');
    return minutes
      ? `Demo control: the board was aged ${minutes} minutes`
      : 'Demo control: the board was aged';
  },
};

export function sentenceFor(event: JobStoryEvent): string {
  const write = SENTENCES[event.eventType];
  // A HUMANISED FALLBACK RATHER THAN THE RAW ENUM. driverUpdates.ts refuses to
  // fall back at all, because a driver reading DISPATCH_REQUEUED is the exact
  // bug that file exists to prevent. A dispatcher is a different reader: they
  // know the domain, an unmapped event is still information, and a phase that
  // adds an event type should not blank a line of the story before somebody
  // writes copy for it. tests/jobStory.test.ts keeps the mapped set honest.
  if (!write) return humanise(event.eventType);
  return write(event.payload);
}

export function tellJobStory(events: JobStoryEvent[]): JobStoryLine[] {
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => ({
      sequence: event.sequence,
      at: typeof event.at === 'string' ? event.at : event.at.toISOString(),
      sentence: sentenceFor(event),
    }));
}
