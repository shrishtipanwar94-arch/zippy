// THE ONE STATE OBJECT.
//
// This is the discipline the whole frontend rests on, and it is worth being
// able to say out loud: there is exactly one place client state lives, the
// socket handler writes to it and calls render(), and NOTHING except a panel's
// render(state) touches the DOM. No handler reaches into the page to "just
// update this one badge". When every change goes state -> render, the page can
// only ever show what the state says, and a bug is either in the state or in
// one render function — never in the six places that quietly disagreed.
//
// The cost is that render() runs on every event. That is why panels patch by
// data-job-id instead of rebuilding: see panels/jobsTable.js.

const state = {
  // Auth
  token: null,
  session: null, // { role, userId }

  // Connection
  connection: 'disconnected', // disconnected | connecting | connected

  // Jobs, keyed by id, with a separate order array so render order is stable
  // and does not depend on object key iteration.
  jobs: {},
  jobOrder: [],

  // The most recent solver result: three plans, plus the counts behind them.
  // Null until a dispatcher presses Solve.
  solve: null,

  // THE INCIDENT TIMELINE. Held here rather than in the panel because the
  // filters and the rows are one piece of state — changing a filter refetches,
  // and the panel must never hold a copy that can disagree with this one.
  timeline: {
    events: [],
    eventTypes: [],
    zones: [],
    filters: { jobId: '', zoneId: '', eventType: '' },
    limit: 200,
    // Keys already rendered, so an at-least-once socket delivery cannot show
    // the same event twice.
    seen: new Set(),
  },

  // WHY THIS TECHNICIAN. `jobId` is what the operator selected; `decision` is
  // what the server said about it. Kept apart so a slow response cannot make
  // the timeline highlight one job while the inspector shows another.
  inspector: { jobId: null, decision: null },

  // Capability scarcity and the priority queue: both whole-board reads,
  // refreshed on demand rather than per event.
  scarcity: { capabilities: [], totalCrewedUnits: 0, totalTechnicians: 0 },
  queue: { jobs: [], at: null },

  // Which plan the dispatcher has taken, and the override reason if they
  // departed from the recommendation.
  planSelection: {
    planVariantId: null,
    label: null,
    isOverride: false,
    error: null,
    // Per-plan override text, held in state rather than left in the DOM: the
    // plans panel rebuilds wholesale, so an input's value would be discarded
    // by any render that happened while the operator was typing.
    reasonDraft: {},
  },

  // jobId -> events, in sequence order
  events: {},
  // jobId -> highest sequence already applied. The idempotency cursor.
  cursors: {},

  // Which job the driver / technician detail panels are showing.
  activeJobId: null,

  // The intake question flow on the driver page.
  nextQuestion: null, // { code, prompt, answers } | null
  intakeDone: null, // stop reason string | null

  error: null,
};

const panels = [];

// A page registers only the panels it actually has. render() then calls each
// one with the whole state; a panel that finds nothing to show renders nothing.
export function registerPanel(renderPanel) {
  panels.push(renderPanel);
}

export function render() {
  for (const renderPanel of panels) {
    renderPanel(state);
  }
}

export function getState() {
  return state;
}

// --- mutations. Every one of these ends in the caller calling render(). ------

export function setSession(token, session) {
  state.token = token;
  state.session = session;
  state.error = null;
}

export function setConnection(status) {
  state.connection = status;
}

export function setError(message) {
  state.error = message;
}

export function putJob(job) {
  if (!state.jobs[job.id]) {
    // Newest first, matching GET /jobs.
    state.jobOrder.unshift(job.id);
  }
  state.jobs[job.id] = { ...state.jobs[job.id], ...job };
}

export function setJobs(jobs) {
  state.jobs = {};
  state.jobOrder = [];
  for (const job of jobs) {
    state.jobs[job.id] = job;
    state.jobOrder.push(job.id);
  }
}

export function setSolve(result) {
  state.solve = result;
}

// A LIVE EVENT, PUSHED. The timeline is fetched once and then kept current by
// the socket — the panel is called "live" and now is.
//
// The filters are applied HERE rather than by the panel, because state is what
// the panel renders: an event that does not match the current filter must not
// enter the array at all, or a filtered view would silently accumulate rows it
// is supposed to be excluding and the count would stop matching the list.
//
// Returns whether anything changed, so the caller can skip a render.
export function pushTimelineEvent(event) {
  const filters = state.timeline.filters;
  if (filters.jobId && event.jobId !== filters.jobId) return false;
  if (filters.zoneId && event.zoneId !== filters.zoneId) return false;
  if (filters.eventType && event.eventType !== filters.eventType) return false;

  // The socket delivers at-least-once (Phase 4), so the same event can arrive
  // twice — on a reconnect replay overlapping the live stream. Keyed on
  // (job, sequence) because that pair is unique per event and is what the
  // server guarantees; the row id is not carried on a socket message.
  const key = `${event.jobId}#${event.sequence}`;
  if (state.timeline.seen.has(key)) return false;
  state.timeline.seen.add(key);

  state.timeline.events.unshift({
    id: key,
    jobId: event.jobId,
    sequence: event.sequence,
    eventType: event.eventType,
    payload: event.payload,
    actorRole: event.actorRole ?? null,
    at: event.at,
    zoneId: event.zoneId ?? '',
    safetyLevel: event.safetyLevel ?? 'NORMAL',
  });

  // Bounded, or a console left open overnight grows without limit. The cap
  // matches the server's page size so the panel behaves the same whether a row
  // arrived by fetch or by socket.
  if (state.timeline.events.length > state.timeline.limit) {
    const dropped = state.timeline.events.pop();
    if (dropped) state.timeline.seen.delete(dropped.id);
  }
  return true;
}

export function setTimeline(result) {
  // The server returns a row id; a socket message does not. Both are keyed on
  // (job, sequence) here so a fetched row and a pushed row for the same event
  // are the same row, and a refetch after a push does not duplicate it.
  state.timeline.events = result.events.map((event) => ({
    ...event,
    id: `${event.jobId}#${event.sequence}`,
  }));
  state.timeline.seen = new Set(state.timeline.events.map((event) => event.id));
  state.timeline.eventTypes = result.eventTypes;
  state.timeline.zones = result.zones;
  state.timeline.limit = result.limit;
}

export function setScarcity(result) {
  state.scarcity = result;
}

export function setQueue(result) {
  state.queue = result;
}

export function setPlanSelection(selection) {
  state.planSelection = { ...state.planSelection, ...selection };
}

export function setOverrideReasonDraft(label, text) {
  state.planSelection.reasonDraft = { ...state.planSelection.reasonDraft, [label]: text };
}

export function setTimelineFilter(name, value) {
  state.timeline.filters[name] = value;
}

export function setInspectorJob(jobId) {
  state.inspector.jobId = jobId;
  // Cleared immediately: showing the previous job's reasoning under a new
  // job's heading is worse than showing nothing for a moment.
  state.inspector.decision = null;
}

export function setInspectorDecision(decision) {
  // Ignore a response that arrived after the operator moved on.
  if (decision && decision.job.id !== state.inspector.jobId) return;
  state.inspector.decision = decision;
}

export function setActiveJob(jobId) {
  state.activeJobId = jobId;
}

export function setNextQuestion(next) {
  // The API answers with either a question or a stop reason, never both.
  if (!next || next.done) {
    state.nextQuestion = null;
    state.intakeDone = next ? next.reason : null;
    return;
  }
  state.nextQuestion = next.question;
  state.intakeDone = null;
}

// THE IDEMPOTENT APPLY, and the reason the server can be at-least-once.
//
// A resubscribe joins the job room before reading the replay, so an event
// committed in that window arrives live AND in the replay. The server cannot
// prevent that without risking a gap instead, so the client is where the
// duplicate dies: an event at or below the cursor has already been applied and
// is dropped. The same rule handles out-of-order arrival, because the cursor
// only ever moves forward.
export function applyJobEvent(event) {
  const applied = state.cursors[event.jobId] ?? 0;
  if (event.sequence <= applied) return false;

  if (!state.events[event.jobId]) state.events[event.jobId] = [];
  state.events[event.jobId].push(event);
  state.events[event.jobId].sort((a, b) => a.sequence - b.sequence);
  state.cursors[event.jobId] = event.sequence;

  // An event is also the only notification that a job exists at all, for a
  // dispatcher who was not watching when it was created.
  if (!state.jobs[event.jobId]) {
    putJob({ id: event.jobId, status: 'INTAKE', safetyLevel: null, createdAt: event.at });
  }

  // The event stream is the only way a second dispatcher's assignment reaches
  // this window. Without this the board would need a reload to show it, which
  // is exactly the thing the socket exists to avoid.
  if (event.eventType === 'UNIT_ASSIGNED') {
    putJob({
      id: event.jobId,
      status: 'PLANNED',
      assignedUnitId: event.payload?.unitId ?? null,
      assignedTechnicianId: event.payload?.technicianId ?? null,
    });
  }
  return true;
}

export function cursorFor(jobId) {
  return state.cursors[jobId] ?? 0;
}

// A truncated replay means the client missed more than the server will replay.
// Its history for that job is untrustworthy, so it is thrown away rather than
// shown with a hole in it.
export function resetJobHistory(jobId) {
  state.events[jobId] = [];
  state.cursors[jobId] = 0;
}
