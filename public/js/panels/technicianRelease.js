// RELEASED FROM A JOB — the notice that never existed.
//
// Phase 13's re-dispatch detaches a technician the new plan does not use,
// returns their van to AVAILABLE, and writes TECHNICIAN_RELEASED_FROM_JOB.
// Nothing read that event until Phase 22b's audit, and `/technician/work`
// filters on `assignedTechnicianId` — so from the technician's side the job
// simply disappeared off the board with no explanation at all. Somebody
// standing next to a car they are no longer meant to fix had no way to tell
// "you are done here" from "the app is broken".
//
// DISMISSED BY THE PERSON, NOT BY A TIMER. It stays until they acknowledge it:
// a notice that clears itself is one they can miss entirely while carrying
// something. The server keeps returning it for six hours (technicianBoard.ts),
// so a dismissal that does not survive a reload is not a correctness problem —
// the acknowledgement is held in page state deliberately, because "I have read
// this" is not a fact the server needs.

const dismissed = new Set();

export function dismissRelease(jobId) {
  dismissed.add(jobId);
}

export function render(state) {
  const panel = document.querySelector('[data-panel="release"]');
  if (!panel) return;

  const releases = (state.work.releases ?? []).filter((release) => !dismissed.has(release.jobId));

  const markup = `
    <div data-panel="release" aria-live="assertive">
      ${releases.map(cardMarkup).join('')}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

// RED, and it is the one place on this page that earns it. Everywhere else red
// is reserved for HIGH_RISK and failures; being stood down mid-job is neither,
// but it is the only message here that is worse to miss than to over-signal.
function cardMarkup(release) {
  return `
    <div class="card release-card mb-3">
      <div class="card-body">
        <h2 class="h6 mb-1">You have been released from a job</h2>
        <p class="mb-3">${escapeText(release.text)}</p>
        <button class="btn btn-outline-light btn-lg w-100" data-dismiss-release="${escapeText(release.jobId)}">
          Understood
        </button>
      </div>
    </div>`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
