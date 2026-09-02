// THE DRIVER'S LIVE PANEL — rendering strings the server already wrote.
//
// EVERY sentence here comes from GET /jobs/:id/driver-view. This file does not
// know what a JobStatus is, has no map from one to English, and must never
// grow one: the whole reason the translation lives on the server
// (src/domain/driverNarrative.ts) is that a second copy in the browser is a
// second place for SCREAMING_CASE to leak onto this screen. If a sentence
// needs changing, it changes there.
//
// The arrival line is a CLOCK TIME, never a countdown. The server sends both
// the instant and the formatted time; this shows the formatted one and does
// not tick. A countdown that stalls at "2 minutes" while a technician sits in
// traffic reads as a broken promise; a clock time that moves reads as news.

function setText(root, field, text) {
  const node = root.querySelector(`[data-field="${field}"]`);
  if (!node) return null;
  if (node.textContent !== text) node.textContent = text;
  return node;
}

export function render(state) {
  const panel = document.querySelector('[data-panel="driver-status"]');
  if (!panel) return;

  const view = state.driverView;
  panel.hidden = !view;
  if (!view) return;

  setText(panel, 'headline', view.headline);
  setText(panel, 'detail', view.detail);

  const arrival = panel.querySelector('[data-field="arrival"]');
  if (arrival) {
    // "rough" is invariant 8 reaching the driver: when routing fell back to a
    // straight-line estimate we say the time is approximate rather than
    // presenting a degraded number as a precise one.
    const text = view.arrival
      ? view.arrival.rough
        ? `Roughly ${view.arrival.clock}`
        : `Arriving ${view.arrival.clock}`
      : '';
    if (arrival.textContent !== text) arrival.textContent = text;
    arrival.hidden = !view.arrival;
  }

  renderHelper(panel, view.helper);

  renderNotification(state.notification);
  renderGuidance(panel, view.guidance);
  renderEstimate(panel, view.estimate);
  renderCode(panel, view.completionCode);
  renderUpdates(view.updates);
}

// WHO IS COMING, as a person rather than a field. The initial in the circle is
// decoration and is hidden from assistive technology; the name beside it is the
// message, and it is the second of the two facts that reduce a stranded
// driver's anxiety most (docs/UI.md — the first is when).
//
// The server sends a first name only. That is deliberate and is src/api/driver.ts's
// decision, not this file's: it is what a stranger walking up to your car
// introduces themselves with, and the employee code is the dispatcher's business.
function renderHelper(panel, helper) {
  const row = panel.querySelector('[data-field="helper-row"]');
  const name = panel.querySelector('[data-field="helper"]');
  if (row) row.hidden = !helper;
  if (!helper || !name) return;

  const text = [helper.name, helper.vehicle].filter(Boolean).join(' · ');
  if (name.textContent !== text) name.textContent = text;

  const initial = panel.querySelector('[data-field="helper-initial"]');
  const letter = helper.name ? helper.name.trim().charAt(0).toUpperCase() : '?';
  if (initial && initial.textContent !== letter) initial.textContent = letter;
}

// ONE COALESCED UPDATE, never a feed. A re-plan fires six events in ninety
// seconds and the driver gets a single message about where things ended up
// (src/workers/notification.ts) — so this is one banner holding the latest,
// not a list that would defeat the coalescing it renders.
function renderNotification(notification) {
  const banner = document.querySelector('[data-field="notification"]');
  if (!banner) return;
  const text = notification ? notification.body : '';
  if (banner.textContent !== text) banner.textContent = text;
  banner.hidden = !notification;
}

// The while-you-wait card. The server picks it from the safety level and
// nothing else (src/domain/safetyGuidance.ts) — this panel would not know how
// to make it situation-specific even if somebody asked it to.
function renderGuidance(panel, guidance) {
  setText(panel, 'guidance-headline', guidance.headline);
  setText(panel, 'guidance-note', guidance.note);

  const list = panel.querySelector('[data-field="guidance-points"]');
  if (!list) return;
  const wanted = guidance.points.join('|');
  if (list.dataset.points === wanted) return;

  list.dataset.points = wanted;
  list.replaceChildren();
  for (const point of guidance.points) {
    const item = document.createElement('li');
    item.textContent = point;
    list.appendChild(item);
  }
}

// Shown ABOVE the completion code in the markup, and that order is the point:
// the driver sees what the work costs before they hand over the code that
// confirms it was done. Generating the estimate is the money domain's job
// (Phase 15c); this renders whatever it has written.
function renderEstimate(panel, estimate) {
  const card = panel.querySelector('[data-field="estimate-card"]');
  if (!card) return;
  card.hidden = !estimate;
  if (!estimate) return;

  setText(panel, 'estimate-total', estimate.total);

  // WHETHER THERE IS ANYTHING TO ANSWER is the server's call, not this panel's
  // — `awaitingAnswer` and `mayDecline` come from GET /jobs/:id/driver-view,
  // computed where the approval history actually lives.
  const actions = panel.querySelector('[data-field="estimate-actions"]');
  if (actions) actions.hidden = !estimate.awaitingAnswer;
  const decline = panel.querySelector('[data-action="decline-estimate"]');
  if (decline) decline.hidden = !estimate.mayDecline;

  const list = panel.querySelector('[data-field="estimate-lines"]');
  if (!list) return;
  list.replaceChildren();
  for (const line of estimate.lines) {
    const item = document.createElement('li');
    item.className = 'd-flex justify-content-between';
    const label = document.createElement('span');
    label.textContent = line.description;
    const amount = document.createElement('span');
    amount.textContent = line.amount;
    item.append(label, amount);
    list.appendChild(item);
  }
}

function renderCode(panel, code) {
  const card = panel.querySelector('[data-field="code-card"]');
  if (!card) return;
  card.hidden = !code;
  if (!code) return;
  setText(panel, 'code', code.code);
  setText(panel, 'code-explain', code.explain);
}

// The story so far, oldest first. morphdom because the list grows and
// occasionally reshapes, and hand-diffing it would mean writing a small diff
// algorithm — the same call jobDetail.js made for the dispatcher's trail.
function renderUpdates(updates) {
  const list = document.querySelector('[data-panel="driver-updates"]');
  if (!list) return;

  const rows =
    updates.length === 0
      ? '<li class="list-group-item text-muted">Nothing yet.</li>'
      : updates.map(updateMarkup).join('');

  // eslint-disable-next-line no-undef
  morphdom(list, `<ul class="list-group" data-panel="driver-updates">${rows}</ul>`);
}

function updateMarkup(update) {
  return `<li class="list-group-item">
      <span class="small text-muted">${escapeText(clockOf(update.at))}</span>
      <span class="ms-2">${escapeText(update.text)}</span>
    </li>`;
}

function clockOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}
