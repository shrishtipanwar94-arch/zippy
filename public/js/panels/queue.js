// THE PRIORITY QUEUE — which job a dispatcher should look at next, and the
// column they live in.
//
// The order comes from the server (src/domain/priority.ts) and this panel does
// not re-sort it. That is deliberate: the ordering rule is invariant 4, and an
// invariant implemented in two places is an invariant implemented in neither.
// If the browser sorted, a bug in either copy would silently produce a
// different queue in the console from the one the rest of the system believes
// in.
//
// WHAT THE PANEL DOES ADD is the three sort keys, shown per row. A queue that
// only shows an order asks to be trusted; a queue that shows safety, SLA
// consumption and age next to each job can be checked. That matters most
// exactly when it looks wrong — an operator who can see that a NORMAL job sits
// above an ELEVATED one knows immediately that something is broken, rather
// than assuming the machine knows best.
//
// ROWS ARE PATCHED BY `data-job-id`, NOT REBUILT. This panel used to call
// `replaceChildren` on every render, and render runs on every socket event —
// so on a busy board the table was destroyed and recreated every few seconds.
// That is the exact discipline Phase 4 set for the jobs table and Phase 14 for
// the timeline, and it was never applied here. It is a READABILITY problem
// before it is a performance one: a dispatcher part-way through reading a row,
// with text selected or the row's button focused, lost both on the next tick.
//
// The list is SORTED rather than append-only, which is what makes this
// different from the timeline. Rows that already exist are updated in place;
// rows that have gone are removed; and the surviving nodes are re-appended in
// the server's order, which moves a row only when its rank actually changed.

const SAFETY_BADGE = {
  HIGH_RISK: { className: 'badge-risk-high', label: 'HIGH RISK' },
  ELEVATED: { className: 'badge-risk-elevated', label: 'ELEVATED' },
  NORMAL: { className: 'badge-risk-normal', label: 'STANDARD' },
};

// A CEILING THIS PANEL ENFORCES ITSELF, on top of the server's limit.
//
// GET /queue returns the top fifty and says so, so in normal operation this
// never bites. It exists because the panel had no opinion at all until now: an
// unbounded response built a row per pending job, and against a dev database
// carrying three thousand of them the console never became interactive — the
// tab wedged before a dispatcher could read anything, which is the worst
// possible failure for the panel that is supposed to tell you what is on fire.
//
// A render function should not be able to be handed a number that kills the
// page. So the cap lives on both sides: the server bounds what it sends
// because that is the endpoint's contract, and the panel bounds what it draws
// because a future caller, a stale deploy or a hand-written ?limit must not be
// able to take the console down.
const MAX_ROWS = 200;

export function render(state) {
  const panel = document.querySelector('[data-panel="queue"]');
  if (!panel) return;

  const table = ensureTable(panel);
  const body = table.querySelector('tbody');
  const returned = state.queue.jobs;
  const jobs = returned.length > MAX_ROWS ? returned.slice(0, MAX_ROWS) : returned;

  // WHAT IS NOT ON SCREEN. `total` is the whole pending queue; the rows are the
  // top of it. Saying so is the difference between a short list and a list that
  // looks complete and is not.
  //
  // Defensive about the field itself, not just the count: an older server, a
  // cached response or a failed fetch can leave `total` undefined, and a
  // caption reading "top 50 of undefined" is worse than no caption.
  const total = Number.isFinite(state.queue.total) ? state.queue.total : jobs.length;
  setSummary(panel, jobs.length, total);

  const empty = panel.querySelector('[data-field="queue-empty"]');
  if (empty) empty.hidden = jobs.length > 0;
  table.hidden = jobs.length === 0;

  const wanted = new Set(jobs.map((job) => job.id));
  for (const row of [...body.children]) {
    if (!wanted.has(row.dataset.jobId)) row.remove();
  }

  const existing = new Map([...body.children].map((row) => [row.dataset.jobId, row]));
  for (const [index, job] of jobs.entries()) {
    const row = existing.get(job.id) ?? buildRow(job);
    updateRow(row, job, index, state);
    // Appending a node already in the parent MOVES it. For a row already in
    // the right place that is a no-op the browser optimises away, so a queue
    // whose order has not changed does not touch the DOM at all.
    body.appendChild(row);
  }
}

// "Showing the top 50 of 3,102." Written only when it says something: with the
// whole queue on screen there is nothing being hidden, and a caption repeating
// the row count would be noise on the panel that can least afford it.
function setSummary(panel, shown, total) {
  const node = panel.querySelector('[data-field="queue-count"]');
  if (!node) return;

  const hidden = total > shown;
  const text = hidden
    ? `Showing the top ${shown} of ${total.toLocaleString()}.`
    : `${total.toLocaleString()} waiting.`;
  if (node.textContent !== text) node.textContent = text;
  node.hidden = total === 0;
}

// Created once. The header never changes, so rebuilding it is pure churn.
function ensureTable(panel) {
  const found = panel.querySelector('[data-field="queue-table"]');
  if (found) return found;

  const table = document.createElement('table');
  table.className = 'table table-sm mb-0 queue-table';
  table.dataset.field = 'queue-table';
  // THREE COLUMNS, NOT FIVE. The left column is 19rem on a 1280px laptop and
  // five columns of badges do not fit in it — the first version of this table
  // grew a horizontal scrollbar, which on the panel a dispatcher lives in is
  // worse than any amount of stacking. The subject stacks into two lines in one
  // cell and the two badges share a wrapping cell, so all three sort keys are
  // still on the row.
  table.innerHTML =
    '<thead><tr>' +
    '<th>#</th><th>vehicle &amp; fault</th><th>risk &amp; sla</th>' +
    '</tr></thead><tbody></tbody>';
  panel.appendChild(table);
  return table;
}

// THE ROW HAS A SUBJECT NOW.
//
// It used to read `g59jpmrj / 2m / HIGH RISK / SLA 19m` — four facts about how
// urgent a job is and not one about what it is. A dispatcher could tell that
// the top row was on fire without being able to tell what was burning, where,
// or whether they had the van for it, which meant every row had to be clicked
// before it could be triaged. Registration and fault answer "what", the second
// line answers "where", and the badges keep answering "how urgent".
//
// The REGISTRATION is the clickable identifier rather than the job id: it is
// what a driver reads off their own car and what the fleet dashboard lists, so
// it is the string two people on a phone can agree on. The job id is still on
// the button's title for anyone cross-referencing the timeline.
function buildRow(job) {
  const row = document.createElement('tr');
  row.dataset.jobId = job.id;
  row.innerHTML =
    '<td class="text-muted" data-cell="rank"></td>' +
    '<td data-cell="job">' +
    '<div class="queue-subject"><span data-cell="fault" class="queue-fault"></span></div>' +
    '<div class="queue-where text-muted">' +
    '<span data-cell="age"></span><span data-cell="where"></span>' +
    '</div>' +
    '</td>' +
    '<td class="queue-badges"><span data-cell="risk"></span> <span data-cell="sla"></span></td>';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-link btn-sm p-0 mono queue-rego';
  button.dataset.action = 'inspect';
  button.dataset.jobId = job.id;
  button.title = job.id;
  button.textContent = job.registration ?? job.id.slice(-8);
  row.querySelector('.queue-subject').prepend(button);

  return row;
}

// Every write is conditional. Setting textContent to the value it already
// holds still dirties the node for the browser, and this runs on every event.
function updateRow(row, job, index, state) {
  setCell(row, 'rank', String(index + 1));
  setCell(row, 'age', `${job.ageMinutes}m`);

  // A fault the server has not named yet is a job intake is still questioning.
  // Saying so beats both a blank and a guess — the hypothesis exists, it just
  // is not settled, and a dispatcher reading "Diagnosing" knows to wait rather
  // than to wonder whether the row is broken.
  setCell(row, 'fault', job.faultLabel ?? 'Diagnosing…');
  setCell(row, 'where', job.locationLabel ?? '');

  // The fault and the place both truncate, so the untruncated string has to be
  // reachable. Title rather than a tooltip component: it costs nothing and
  // works on a keyboard focus as well as a hover.
  setTitle(row, 'fault', job.faultLabel ?? '');
  setTitle(row, 'where', job.locationLabel ?? '');

  const risk = SAFETY_BADGE[job.safetyLevel] ?? SAFETY_BADGE.NORMAL;
  setBadge(row, 'risk', risk.label, risk.className);

  const sla = slaBadge(job);
  setBadge(row, 'sla', sla.label, sla.className);

  // WHICH ROW IS BEING INVESTIGATED. The right-hand column is about one job,
  // and without this there is nothing on screen saying which.
  const selected = state.inspector.jobId === job.id;
  if (row.classList.contains('is-selected') !== selected) {
    row.classList.toggle('is-selected', selected);
  }
}

// COLOUR IS NEVER THE ONLY SIGNAL (docs/UI.md). Every one of these carries the
// word as well — a left border and a red tint do not survive a colourblind
// operator, a bad monitor, or the sun on a laptop screen.
function slaBadge(job) {
  if (job.slaResponseMinutes === null) {
    return { label: 'NO SLA', className: 'badge-sla-none' };
  }
  // `slaRisk` is elapsed/window, so the window's remainder is the figure an
  // operator actually acts on. Derived here rather than sent, because the
  // server already sends both halves and a third field could disagree.
  const remaining = Math.round(job.slaResponseMinutes - job.ageMinutes);
  // "LATE 947m", not "SLA LATE 947m". The badge sits under one that already
  // says HIGH RISK in a fixed-width column, and the longer wording was the
  // single widest string in the queue — it set the column's width, and every
  // row paid for it by truncating the fault. Dropping a word nothing depends
  // on (the row's other badge is the SLA one; there is nothing else "late"
  // could refer to) gives that width back to what the job actually is.
  if (remaining <= 0) return { label: `LATE ${-remaining}m`, className: 'badge-sla-late' };
  if (job.slaRisk >= 0.75) return { label: `SLA ${remaining}m`, className: 'badge-sla-near' };
  return { label: `SLA ${remaining}m`, className: 'badge-sla-ok' };
}

function setCell(row, cell, text) {
  const node = row.querySelector(`[data-cell="${cell}"]`);
  if (node && node.textContent !== text) node.textContent = text;
}

function setTitle(row, cell, text) {
  const node = row.querySelector(`[data-cell="${cell}"]`);
  if (node && node.title !== text) node.title = text;
}

function setBadge(row, cell, label, className) {
  const badge = row.querySelector(`[data-cell="${cell}"]`);
  if (!badge) return;
  const wanted = `queue-badge ${className}`;
  if (badge.textContent !== label) badge.textContent = label;
  if (badge.className !== wanted) badge.className = wanted;
}
