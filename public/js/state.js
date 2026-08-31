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
  },

  // WHY THIS TECHNICIAN. `jobId` is what the operator selected; `decision` is
  // what the server said about it. Kept apart so a slow response cannot make
  // the timeline highlight one job while the inspector shows another.
  inspector: { jobId: null, decision: null },

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

export function setTimeline(result) {
  state.timeline.events = result.events;
  state.timeline.eventTypes = result.eventTypes;
  state.timeline.zones = result.zones;
  state.timeline.limit = result.limit;
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
