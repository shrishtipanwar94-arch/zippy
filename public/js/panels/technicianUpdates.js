// WHAT HAS HAPPENED ON THIS JOB — sentences, on a phone.
//
// This heading used to render jobDetail.js, which is the DISPATCHER's panel: it
// shows the raw event type, an ISO timestamp and the JSON payload in a <code>
// block, because for an operator reading an audit trail that is exactly right.
// On a technician's phone in daylight it was a wall of SCREAMING_CASE and
// braces, and it was the clearest single example of the "keys of a table"
// problem this redesign is about.
//
// The wording is the SERVER's (src/domain/technicianUpdates.ts), whitelisted the
// same way the driver's feed is: an event type nobody has written a sentence for
// produces nothing rather than leaking its name onto the screen.

export function render(state) {
  const list = document.querySelector('[data-panel="technician-updates"]');
  if (!list) return;

  const job = state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId)
    ?? state.work.jobs[0];
  const updates = job?.updates ?? [];

  const markup = `
    <ul class="list-group" data-panel="technician-updates">
      ${
        updates.length === 0
          ? '<li class="list-group-item text-secondary">Nothing yet.</li>'
          : updates.map(itemMarkup).join('')
      }
    </ul>`;

  // eslint-disable-next-line no-undef
  morphdom(list, markup);
}

function itemMarkup(update) {
  return `
    <li class="list-group-item">
      <div>${escapeText(update.text)}</div>
      <div class="small text-secondary">${escapeText(clockTime(update.at))}</div>
    </li>`;
}

// A CLOCK TIME, never an ISO string and never a countdown. The driver's surface
// made the same choice for the same reason: "14:32" is a fact a person can act
// on, and "2026-09-02T09:02:11.482Z" is a database column.
function clockTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
