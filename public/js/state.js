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
  // `jobs` is the TOP of the queue, not all of it; `total` is how many are
  // waiting. The panel needs both to say what it is not showing.
  queue: {
    jobs: [],
    total: 0,
    activeIncidentCount: 0,
    slaAtRiskCount: 0,
    limit: 0,
    at: null,
  },

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

  // THE DRIVER'S REQUEST FLOW — symptoms, then safety, then location. Held
  // here rather than read out of the form at submit time, so a re-render
  // triggered by an unrelated socket event cannot lose what has been answered.
  request: {
    step: 'describe', // describe | symptoms | safety | location | sent
    vehicleId: '',
    complaint: null,
    safety: {},
    location: { lat: null, lng: null, roadPosition: null, landmark: '' },
    locating: false,

    // WHAT THE ASSISTANT READ (Phase 16). All of it is a PROPOSAL: the driver
    // confirms or corrects every field before anything is sent, and the job is
    // built from what they submit, never from this.
    describing: false,
    // True when the extractor was unavailable and the driver is on the picker.
    // Drives the banner — a degraded state nobody can see is not a degraded
    // state, it is a bug (invariant 8).
    aiDegraded: false,
    // The id of the AiExtraction row this request is answering, sent back at
    // intake so "the driver confirmed what the model read" is a fact in the
    // database rather than an inference from two timestamps.
    extractionId: null,
    // The extracted symptom payload, and the driver's own words. The payload is
    // what gets submitted when the driver leaves the complaint alone.
    extracted: null,
    rawText: null,
    aiEvidence: null,
    // Safety signals the assistant heard, used to pre-tick the checkboxes on
    // the safety step — until the driver touches that step, after which their
    // answers are the only ones that count.
    safetyProposed: [],
    safetyTouched: false,
  },

  // THE DEGRADATION LADDER (Phase 17), as GET /health reports it. Null until
  // the first poll answers. `mode`, `message` and every component's wording
  // come from the server — see public/js/panels/health.js.
  // WHETHER THE TECHNICIAN HAS ANSWERED THE PARTS PROMPT on the completion
  // step, keyed by job. Not a fact about the job — it is a fact about this
  // screen, and it must not survive a refetch of the board, which is why it
  // lives here rather than being derived from the server's copy.
  completionParts: {},
  health: null,
  // The drill-through behind the health banner's payments line. `null` until an
  // operator asks for it — the banner is polled every fifteen seconds and
  // fetching a list nobody opened on every tick would be a request per tick for
  // a panel that is usually closed.
  stuckPayments: null,

  // The chaos panel. `available` stays false until the server answers GET
  // /chaos, which a production build never does, so the panel cannot appear
  // where it must not exist.
  chaos: { available: false, switches: [], note: null },

  // The escalation card for the job in the inspector, when it has no plan.
  escalation: null,
  // What the dispatcher decided about it, once they have. A sentence, not a
  // code — it is read by the person who just pressed the button.
  escalationDecision: null,

  // WHAT THE DRIVER SEES, AS THE SERVER WORDED IT. The whole panel is one
  // server response (GET /jobs/:id/driver-view) rather than a status the
  // browser translates, which is what makes "no enum ever reaches a driver" a
  // property the test suite can check instead of a habit.
  driverView: null,

  // CHAT AND THE FLAGGED MESSAGES WAITING ON A HUMAN.
  //
  // `promotions` holds only what is still FLAGGED. A confirmed or dismissed one
  // is removed rather than marked, because a card whose buttons no longer do
  // anything is worse than no card — and the server is the record of what was
  // decided, not this array.
  chat: { messages: [], draft: '' },
  promotions: [],
  // The last coalesced update the server sent. One at a time: a re-plan
  // produces exactly one of these (workers/notification.ts), so a list would
  // only ever hold one thing.
  notification: null,

  // The technician's board: open offers, the job in hand, and any job a re-plan
  // has released them from (Phase 13, surfaced in Phase 22b).
  work: { offers: [], jobs: [], releases: [] },

  // What the technician is owed. Read on demand rather than on every board
  // poll: it is a running account that outlives every job on the screen.
  earnings: null,

  // THE VAN (Phase 18). `stock` is the server's answer — quantities and how
  // long ago each shelf was counted. `counts` is what the technician has typed
  // into the count boxes and not yet confirmed, held here for exactly the
  // reason planSelection.reasonDraft is: this page re-renders every second on
  // the offer countdown, and a value that lives only in the DOM is discarded
  // by the next render.
  van: { stock: null, counts: {} },
  // Re-read every second so an offer countdown ticks. The countdown is derived
  // from `expiresAt` and this, never decremented — a decremented counter
  // drifts whenever the tab is backgrounded.
  now: Date.now(),
  // What the offline queue is holding, mirrored into state so panels render it
  // like everything else.
  outbox: { pending: [], results: [], online: true },

  // THE FLEET MANAGER'S DASHBOARD (Phase 21). One whole-board read, refreshed
  // on demand — the same treatment scarcity and queue get, and for the same
  // reason: this is a summary a person checks, not a live feed a socket event
  // should be patching mid-glance.
  // THE ACTION QUEUE (Phase 13). RECOMMEND and APPROVE rows waiting on a
  // dispatcher. The backend has had these since Phase 13; nothing rendered them
  // until Phase 22b's audit.
  actions: [],

  fleetDashboard: null,

  // THE CALLOUT FEE'S CHECKOUT (Phase 22b). The server's answer to "is there
  // anything to pay, and can it be paid": READY, ALREADY_PAID, NOTHING_TO_PAY
  // or UNAVAILABLE. Null until asked, and asking is never on the path to
  // getting help.
  checkout: null,

  // THE DRIVER'S OWN VEHICLES, for the picker on the request screen. Loaded
  // once at sign-in: a person's cars do not change while they are standing at
  // the roadside, and re-fetching on every render would be a request per
  // keystroke.
  vehicles: [],

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

export function setRequestField(patch) {
  state.request = { ...state.request, ...patch };
}

export function setCompletionParts(jobId, answer) {
  state.completionParts[jobId] = answer;
}

export function setStuckPayments(payments) {
  state.stuckPayments = payments;
}

export function setHealth(health) {
  state.health = health;
}

export function setChaos(patch) {
  state.chaos = { ...state.chaos, ...patch };
}

export function setEscalation(card) {
  state.escalation = card;
  // A new card is a new question; whatever was decided about the last job is
  // not an answer to it.
  state.escalationDecision = null;
}

export function setEscalationDecision(sentence) {
  state.escalationDecision = sentence;
}

export function setChatMessages(messages) {
  state.chat.messages = messages;
}

// One message, from the socket. Keyed on the message id because the fan-out is
// best-effort and a refetch can overlap a push — the same de-duplication rule
// the timeline uses, for the same reason.
export function pushChatMessage(message) {
  if (state.chat.messages.some((existing) => existing.messageId === message.messageId)) return false;
  state.chat.messages.push(message);
  return true;
}

export function setChatDraft(text) {
  state.chat.draft = text;
}

export function setPromotions(promotions) {
  state.promotions = promotions;
}

export function pushPromotion(promotion) {
  if (state.promotions.some((existing) => existing.promotionId === promotion.promotionId)) return false;
  state.promotions.push(promotion);
  return true;
}

export function removePromotion(promotionId) {
  state.promotions = state.promotions.filter(
    (promotion) => promotion.promotionId !== promotionId,
  );
}

export function setNotification(notification) {
  state.notification = notification;
}

export function setDriverView(view) {
  state.driverView = view;
}

export function setActions(actions) {
  state.actions = actions;
}

export function setCheckout(checkout) {
  state.checkout = checkout;
}

export function setVehicles(vehicles) {
  state.vehicles = vehicles;
}

export function setWork(work) {
  state.work = { releases: [], ...work };
}

export function setEarnings(earnings) {
  state.earnings = earnings;
}

export function setVanStock(stock) {
  state.van.stock = stock;
  // Every count box goes back to what the server just said. A number the
  // technician typed before a refresh is not a count they have committed to,
  // and carrying it over the top of fresh data is how a stale figure gets
  // confirmed as if somebody had looked.
  state.van.counts = {};
}

export function setVanCount(partId, value) {
  state.van.counts = { ...state.van.counts, [partId]: value };
}

export function tickClock() {
  state.now = Date.now();
}

export function setOutbox(outbox) {
  state.outbox = outbox;
}

export function setFleetDashboard(dashboard) {
  state.fleetDashboard = dashboard;
}

// A PAGE ASKING TO BE TOLD. The socket writes state and calls render(), which
// is enough when everything a panel needs is already in state. The driver's
// panel is not: its sentences live on the server, so an event means "re-read
// the driver view", which is a fetch rather than a state write. Rather than
// let a render function quietly do I/O, a page registers here and the socket
// calls it after applying an event.
const jobEventListeners = [];

export function onJobEvent(listener) {
  jobEventListeners.push(listener);
}

export function notifyJobEvent(jobId) {
  for (const listener of jobEventListeners) listener(jobId);
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
