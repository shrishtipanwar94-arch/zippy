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

import { icon } from '../icons.js';

const CONFIDENCE = {
  VERIFIED: { badge: 'bg-success', pill: 'is-ok', label: 'counted' },
  AGEING: { badge: 'bg-warning text-dark', pill: 'is-warn', label: 'getting old' },
  UNVERIFIED: { badge: 'bg-danger', pill: 'is-danger', label: 'not counted' },
};

export function render(state) {
  const panel = document.querySelector('[data-panel="van-stock"]');
  if (!panel) return;

  const stock = state.van.stock;
  const markup = `
    <div data-panel="van-stock" class="mb-4">
      ${stock ? stockMarkup(stock, state) : emptyMarkup('The van list has not loaded yet.')}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

// AN EMPTY PANEL SHOULD LOOK EMPTY, NOT BROKEN. A bare grey line reads as a
// panel that failed to load — which is exactly the wrong impression for the
// one that says whether the van has been counted. `.empty` is the shared
// component (components.css); the technician's ladder uses the same one.
function emptyMarkup(sentence) {
  return `<div class="empty">${icon('inbox')}<p class="mb-0">${escapeText(sentence)}</p></div>`;
}

function stockMarkup(stock, state) {
  // The job the "fitted" buttons declare against. With nothing in hand there
  // is no job to attribute a part to, so those buttons are disabled rather
  // than hidden — a missing button reads as a broken screen.
  const job = state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId)
    ?? state.work.jobs[0];
  const offline = !state.outbox.online;

  return `
    <p class="section-head">My van <span class="meta mono">${escapeText(stock.unitCode)}</span></p>
    <div class="card">
      <div class="card-body">
        <!-- ONE LINE, NOT THREE COUNTS THAT WRAP MID-PHRASE. The old summary
             put three badge-and-label pairs on one row, which orphaned "not
             counted" onto a line of its own at 390px. The number that needs
             acting on is the uncounted one; the rest is arithmetic the list
             below already shows. -->
        <p class="van-summary mb-3">
          ${
            stock.summary.unverified > 0
              ? `<span class="pill is-danger">${stock.summary.unverified} to count</span>`
              : `<span class="pill is-ok">All counted</span>`
          }
          <span class="text-muted">of ${stock.lines.length} parts</span>
        </p>
        ${stock.lines.length === 0 ? emptyMarkup('This van carries no parts.') : ''}
        <ul class="list-unstyled mb-3">
          ${stock.lines.map((line) => lineMarkup(line, job, offline, state)).join('')}
        </ul>
        <!-- ONE ACTION FOR THE WHOLE VAN. Fourteen uncounted parts at one tap
             each is not something anybody does at the end of a shift, so this
             confirms every line at whatever figure is in its box — which is the
             on-board figure unless the technician changed one. Per-line
             adjustment above stays for the ones that are wrong. -->
        <button class="btn btn-secondary-solid w-100 tech-action" data-action="confirm-count">
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
          <!-- THE SAME FACT WAS STATED THREE TIMES per part: in the summary
               count, in the badge, and again as "never counted" under the SKU.
               The badge is the one that carries it — it is the coloured thing
               the eye lands on — so the sub-line now only says when, and only
               when there is a when to say. -->
          <span class="small text-muted">${escapeText(line.sku)}${
            line.minutesSinceConfirmed === null ? '' : ` · ${escapeText(lastCounted(line))}`
          }</span>
        </div>
        <span class="pill ${confidence.pill}">${escapeText(confidence.label)}</span>
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
