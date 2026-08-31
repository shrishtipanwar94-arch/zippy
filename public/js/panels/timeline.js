// LIVE INCIDENT TIMELINE — the JobEvent stream, filterable by job, zone and
// event type.
//
// THE THING THIS PANEL IS ACTUALLY ABOUT IS SCROLL POSITION. The build plan's
// own check is: run the simulator at 40 jobs/hour, scroll halfway down, and
// wait. If the list jumps or flickers, a panel is blasting innerHTML. Events
// arrive every few seconds, so a naive `container.innerHTML = rows.join('')`
// destroys and recreates every row on every event — which throws away scroll
// position, any text selection, and the row the operator was reading.
//
// So rows are PATCHED BY KEY, exactly like the jobs table:
//   - a row already on screen is left alone entirely (its content cannot
//     change — job_events is append-only, so an event is immutable once
//     written)
//   - a genuinely new event is prepended
//   - a row that no longer matches the filter is removed
//
// Because events are immutable, "left alone entirely" is not an optimisation
// with a correctness caveat — there is no case where an existing row's content
// needs updating. That is a property of the append-only table, and it is what
// makes this panel cheap.
//
// SCROLL IS ONLY PRESERVED IF NEW ROWS GO ON TOP AND THE OPERATOR IS NOT AT
// THE TOP. Prepending to a scrolled-down list pushes content down by the
// height of what was added, so the offset is corrected explicitly afterwards.
// Without that, reading row 40 while three events arrive silently moves you to
// row 43.

const SAFETY_CLASS = {
  HIGH_RISK: 'safety-HIGH_RISK',
  ELEVATED: 'safety-ELEVATED',
  NORMAL: '',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="timeline"]');
  if (!panel) return;

  renderFilters(state);

  const list = panel.querySelector('[data-field="timeline-rows"]');
  const scroller = panel.querySelector('.timeline-scroll');
  if (!list || !scroller) return;

  const events = state.timeline.events;
  const summary = document.querySelector('[data-field="timeline-summary"]');
  if (summary) {
    summary.textContent = `${events.length} event(s)${
      events.length === state.timeline.limit ? ` (capped at ${state.timeline.limit})` : ''
    }`;
  }

  // Measured BEFORE any mutation: the correction below needs the height the
  // list had when the operator last saw it.
  const previousHeight = list.scrollHeight;
  const previousTop = scroller.scrollTop;
  const wasAtTop = previousTop <= 2;

  const wanted = new Set(events.map((event) => event.id));
  for (const row of [...list.children]) {
    if (!wanted.has(row.dataset.eventId)) row.remove();
  }

  // Oldest first so that prepending each in turn leaves the newest at the top.
  const existing = new Set([...list.children].map((row) => row.dataset.eventId));
  for (const event of [...events].reverse()) {
    if (existing.has(event.id)) continue;
    list.prepend(buildRow(event, state));
  }

  // THE SCROLL CORRECTION. If the operator was reading part-way down, shift by
  // exactly how much taller the list became, so the row under their eyes stays
  // under their eyes. If they were at the top they want to see what just
  // arrived, so leave them there.
  if (!wasAtTop) {
    scroller.scrollTop = previousTop + (list.scrollHeight - previousHeight);
  }
}

function buildRow(event, state) {
  const row = document.createElement('div');
  row.className = 'timeline-row d-flex gap-2 align-items-baseline';
  row.dataset.eventId = event.id;
  row.dataset.jobId = event.jobId;
  if (state.inspector.jobId === event.jobId) row.classList.add('is-selected');

  const time = document.createElement('span');
  time.className = 'mono text-muted';
  time.textContent = new Date(event.at).toLocaleTimeString();

  const type = document.createElement('span');
  type.className = 'event-type';
  type.textContent = event.eventType;

  const job = document.createElement('button');
  job.type = 'button';
  job.className = 'btn btn-link btn-sm p-0 mono';
  job.dataset.action = 'inspect';
  job.dataset.jobId = event.jobId;
  job.textContent = event.jobId.slice(-8);

  const zone = document.createElement('span');
  zone.className = 'text-muted mono';
  zone.textContent = event.zoneId;

  // Colour is never the only signal (docs/UI.md): the level is written out.
  const safety = document.createElement('span');
  safety.className = SAFETY_CLASS[event.safetyLevel] ?? '';
  safety.textContent = event.safetyLevel === 'NORMAL' ? '' : event.safetyLevel;

  const actor = document.createElement('span');
  actor.className = 'text-muted ms-auto mono';
  actor.textContent = event.actorRole ?? '';

  row.append(time, type, job, zone, safety, actor);
  return row;
}

// The filter selects are rebuilt only when their options change, stamped with
// a signature — the same trick the Phase 4 unit dropdown used, and for the
// same reason: replacing a select under an operator's cursor resets what they
// had chosen.
function renderFilters(state) {
  fillSelect(
    document.querySelector('[data-field="filter-event-type"]'),
    state.timeline.eventTypes.map((row) => ({
      value: row.eventType,
      label: `${row.eventType} (${row.count})`,
    })),
    'any event type',
  );
  fillSelect(
    document.querySelector('[data-field="filter-zone"]'),
    state.timeline.zones.map((zone) => ({ value: zone.id, label: zone.name })),
    'any zone',
  );
}

function fillSelect(select, options, emptyLabel) {
  if (!select) return;
  const signature = options.map((option) => option.value).join(',');
  if (select.dataset.signature === signature) return;

  const chosen = select.value;
  select.dataset.signature = signature;
  select.replaceChildren();

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = emptyLabel;
  select.appendChild(blank);

  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.appendChild(element);
  }

  // Restore whatever was selected, if it still exists.
  if (chosen && options.some((option) => option.value === chosen)) select.value = chosen;
}
