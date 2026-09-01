// WHAT IS IN THE BACK OF THE VAN, and how much we should believe it.
//
// The number is only half the row. The other half is when somebody last
// looked: a count taken forty minutes ago and a count taken yesterday are not
// the same claim, and from Phase 19 they will not be treated as the same claim
// either — UNVERIFIED stock counts as unavailable to the solver. So the badge
// is not decoration, it is the field the next phase reads.
//
// TWO ACTIONS ON ONE LIST, deliberately. "Fitted one" declares a part used on
// the job in hand and goes through the offline queue like every other tap.
// "I have counted the van" sends what is in the boxes and is the only thing in
// the whole system that can make a shelf VERIFIED again. They are on the same
// screen because a technician who has just fitted a part is standing exactly
// where they can see what is left.
//
// The count boxes read from state, never from the DOM. This page re-renders
// once a second on the offer countdown, so a value living only in an input is
// gone by the time it is read.

const CONFIDENCE = {
  VERIFIED: { badge: 'bg-success', label: 'counted recently' },
  AGEING: { badge: 'bg-warning text-dark', label: 'getting old' },
  UNVERIFIED: { badge: 'bg-danger', label: 'not counted' },
};

export function render(state) {
  const panel = document.querySelector('[data-panel="van-stock"]');
  if (!panel) return;

  const stock = state.van.stock;
  const markup = `
    <div data-panel="van-stock" class="mb-4">
      ${stock ? stockMarkup(stock, state) : '<p class="text-muted">No van stock loaded.</p>'}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

function stockMarkup(stock, state) {
  // The job the "fitted" buttons declare against. With nothing in hand there
  // is no job to attribute a part to, so those buttons are disabled rather
  // than hidden — a missing button reads as a broken screen.
  const job = state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId)
    ?? state.work.jobs[0];
  const offline = !state.outbox.online;

  return `
    <h2 class="h6">
      My van <span class="text-muted">${escapeText(stock.unitCode)}</span>
    </h2>
    <div class="card">
      <div class="card-body">
        <p class="small mb-3">
          <span class="badge bg-success">${stock.summary.verified}</span> counted recently ·
          <span class="badge bg-warning text-dark">${stock.summary.ageing}</span> getting old ·
          <span class="badge bg-danger">${stock.summary.unverified}</span> not counted
        </p>
        ${stock.lines.length === 0 ? '<p class="mb-0">This van carries no parts.</p>' : ''}
        <ul class="list-unstyled mb-3">
          ${stock.lines.map((line) => lineMarkup(line, job, offline, state)).join('')}
        </ul>
        <button class="btn btn-outline-success w-100" data-action="confirm-count">
          I have counted the van
        </button>
      </div>
    </div>`;
}

function lineMarkup(line, job, offline, state) {
  const confidence = CONFIDENCE[line.confidence] ?? CONFIDENCE.UNVERIFIED;
  const counted = state.van.counts[line.partId] ?? String(line.quantity);

  return `
    <li class="border-bottom py-2">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div>
          <span class="d-block">${escapeText(line.name)}</span>
          <span class="small text-muted">${escapeText(line.sku)} · ${escapeText(lastCounted(line))}</span>
        </div>
        <span class="badge ${confidence.badge}">${escapeText(confidence.label)}</span>
      </div>
      <div class="d-flex align-items-center gap-2 mt-2">
        <span class="small">on board</span>
        <input class="form-control form-control-sm" style="width: 5rem"
               type="number" min="0" inputmode="numeric"
               data-count="${escapeText(line.partId)}" value="${escapeText(counted)}" />
        <button class="btn btn-sm btn-outline-primary ms-auto"
                data-fitted="${escapeText(line.partId)}"
                ${job && line.quantity > 0 ? '' : 'disabled'}>
          Fitted one
        </button>
      </div>
      ${offline ? '<p class="small text-muted mb-0 mt-1">Will send when you are back online.</p>' : ''}
    </li>`;
}

// The age in words, because "confirmedAt: 2026-09-01T04:12:00Z" is not a
// sentence anybody reads at the roadside.
function lastCounted(line) {
  if (line.minutesSinceConfirmed === null) return 'never counted';
  if (line.minutesSinceConfirmed < 60) return `counted ${line.minutesSinceConfirmed} min ago`;
  const hours = Math.floor(line.minutesSinceConfirmed / 60);
  return `counted ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
