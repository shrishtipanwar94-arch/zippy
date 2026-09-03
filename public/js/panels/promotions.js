// THE CONFIRMATION CARD — the human in the middle, made visible.
//
// A flagged message sits here until somebody answers it. Nothing about the job
// has changed while this card is on screen, and that is the entire point of
// Phase 15b: the gap between "a message said something" and "the system acted
// on it" is a person, and this card is where that person stands.
//
// ONE PANEL, TWO AUDIENCES, FILTERED BY THE SERVER'S ANSWER. The driver sees
// only cards whose confirmer is DRIVER; an operator sees the rest. That
// filtering is a convenience, not a control — the server refuses a wrong
// confirmer with a 403 regardless (src/domain/promotionPolicy.ts). Showing a
// card somebody cannot act on would just be a button that always fails.
//
// THE QUESTION AND THE BUTTON LABELS COME FROM THE SERVER, from the same policy
// table that decides who is asked. A dialog whose wording lives in the browser
// and whose routing lives on the server is two things that drift apart.

export function render(state) {
  const panel = document.querySelector('[data-panel="promotions"]');
  if (!panel) return;

  const mine = state.promotions.filter((promotion) => isForMe(promotion, state));

  // WHICH JOB, on the console only. A driver and a technician are looking at
  // one incident and the id would be noise; a dispatcher holds a whole zone and
  // a card pushed for a job they are not currently inspecting is unreadable
  // without it. The surface asks for it in its own markup rather than this file
  // guessing from the role.
  const showJob = panel.dataset.showJob === 'true';
  const className = panel.className;

  const markup = `
    <div data-panel="promotions" data-show-job="${showJob}" class="${escapeText(className)}">
      ${mine.map((promotion) => cardMarkup(promotion, showJob)).join('')}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

// DRIVER cards go to a driver; OPERATOR cards go to a technician or dispatcher.
function isForMe(promotion, state) {
  const role = state.session?.role;
  if (!role) return false;
  if (promotion.confirmer === 'DRIVER') return role === 'DRIVER';
  return role === 'TECHNICIAN' || role === 'DISPATCHER';
}

function cardMarkup(promotion, showJob) {
  const job = showJob
    ? `<div class="mono small text-muted mb-1">${escapeText(promotion.jobId ?? '')}</div>`
    : '';
  return `
    <div class="card promotion-card mb-3" data-promotion-id="${escapeText(promotion.promotionId)}">
      <div class="card-body">
        ${job}
        <p class="h5 mb-1">${escapeText(promotion.question)}</p>
        <p class="small mb-2">${escapeText(promotion.because)}</p>
        ${whyFlagged(promotion)}
        <div class="d-flex gap-2">
          <button class="btn btn-danger btn-lg flex-grow-1"
                  data-confirm="${escapeText(promotion.promotionId)}">
            ${escapeText(promotion.yes)}
          </button>
          <button class="btn btn-outline-light btn-lg"
                  data-dismiss="${escapeText(promotion.promotionId)}">
            ${escapeText(promotion.no)}
          </button>
        </div>
      </div>
    </div>`;
}

// WHY THIS WAS FLAGGED, in the words that actually fired. A confirmation
// screen that will not say what triggered it is one people learn to dismiss
// without reading — the same argument that puts reason codes on a feasibility
// rejection instead of a bare "no".
function whyFlagged(promotion) {
  if (!promotion.matched || promotion.matched.length === 0) return '';
  const words = promotion.matched.map((word) => `“${escapeText(word)}”`).join(', ');
  // WHO WROTE IT depends on who is reading. A DRIVER card is about the reader's
  // own message; an OPERATOR card is about the driver's. This said "you wrote"
  // to everybody, which was merely odd on the technician's page and became
  // plainly wrong once the dispatcher's console started rendering these cards.
  const who = promotion.confirmer === 'DRIVER' ? 'you wrote' : 'the driver wrote';
  return `<p class="small text-muted mb-2">Flagged because ${who} ${words}.</p>`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
