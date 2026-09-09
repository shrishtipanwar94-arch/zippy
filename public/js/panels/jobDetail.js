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

// A SENTENCE AND A TIME, with the machinery underneath for anyone who wants it.
//
// This list used to be the event type in bold over a JSON blob, which is the
// log rather than the story: reading one job meant translating enum names and
// payloads in your head. The sentence comes from the server
// (src/domain/jobStory.ts) so there is one vocabulary and it cannot drift from
// the events it describes.
//
// THE RAW EVENT IS STILL HERE, folded away. It is the thing you actually want
// at 2am when a sentence is not enough, and hiding it entirely would trade one
// unreadable panel for one that cannot be debugged.
function eventMarkup(event) {
  const payload = JSON.stringify(event.payload ?? {});
  const sentence = event.sentence ?? event.eventType;
  return `
    <li class="list-group-item" data-sequence="${event.sequence}">
      <div class="d-flex justify-content-between align-items-baseline gap-2">
        <span>${escapeText(sentence)}</span>
        <span class="small text-muted text-nowrap">${escapeText(clockTime(event.at))}</span>
      </div>
      <details class="mt-1">
        <summary class="small text-muted">${escapeText(event.eventType)}</summary>
        <code class="small">${escapeText(payload)}</code>
      </details>
    </li>`;
}

// The wall clock, because a story is read in times of day rather than ISO
// stamps. Date parsing stays in the browser deliberately: the server has no
// business guessing which timezone the reader is sitting in.
function clockTime(at) {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return String(at ?? '');
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
