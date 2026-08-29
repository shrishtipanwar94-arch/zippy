// The event trail for one job, newest last, exactly as the server sequenced it.
//
// This is where morphdom earns its place. The list changes shape rather than
// just changing values — events append, a replay can insert several at once,
// and a truncated replay empties it — so hand-patching would mean writing a
// small diff algorithm. morphdom takes the markup we would have set as
// innerHTML and applies only the differences to the live tree, which keeps the
// scroll position and any text selection inside it.
//
// The table panel does NOT use it: there, patching by data-job-id is three
// lines and exact, and reaching for a library would be the fiddlier option.

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}

function eventMarkup(event) {
  const payload = JSON.stringify(event.payload ?? {});
  return `
    <li class="list-group-item" data-sequence="${event.sequence}">
      <span class="badge bg-secondary">${event.sequence}</span>
      <strong>${escapeText(event.eventType)}</strong>
      <div class="small text-muted">${escapeText(event.at)}</div>
      <code class="small">${escapeText(payload)}</code>
    </li>`;
}

export function render(state) {
  const list = document.querySelector('[data-panel="job-events"]');
  if (!list) return;

  const jobId = state.activeJobId;
  const events = jobId ? (state.events[jobId] ?? []) : [];

  const markup = `
    <ul class="list-group" data-panel="job-events">
      ${
        events.length === 0
          ? '<li class="list-group-item text-muted">No events yet.</li>'
          : events.map(eventMarkup).join('')
      }
    </ul>`;

  // eslint-disable-next-line no-undef
  morphdom(list, markup);

  const heading = document.querySelector('[data-field="active-job"]');
  if (heading) {
    const text = jobId ? jobId : 'none';
    if (heading.textContent !== text) heading.textContent = text;
  }
}
