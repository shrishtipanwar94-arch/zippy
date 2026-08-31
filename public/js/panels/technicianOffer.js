// JOB OFFERS, WITH A VISIBLE COUNTDOWN.
//
// THE COUNTDOWN IS DERIVED, NEVER DECREMENTED. The server sends `expiresAt` as
// an instant; this computes `expiresAt - state.now` on every render, and the
// page ticks `state.now` once a second. A counter that decrements itself
// drifts the moment the tab is backgrounded — phones suspend timers
// aggressively — and would then show a technician fifteen seconds that do not
// exist. The clock is the source of truth, and the difference is the display.
//
// The deadline is real on the server too: the offer-expiry worker times the
// offer out and the saga compensates (src/workers/offerExpiry.ts). So a
// countdown reaching zero is not a UI convention — it is the moment the job is
// genuinely offered to somebody else.
//
// ONLINE ONLY, and the card says so. Forty-five seconds cannot be answered
// from an offline queue that drains ten minutes later; the buttons disable and
// explain rather than swallowing the tap.

// Under this many seconds the card turns urgent. Paired with the word
// "seconds left" — colour is never the only signal (docs/UI.md).
const URGENT_SECONDS = 15;

export function render(state) {
  const panel = document.querySelector('[data-panel="offers"]');
  if (!panel) return;

  const offers = state.work.offers.filter((offer) => secondsLeft(offer, state.now) > 0);

  const markup = `
    <div data-panel="offers" class="mb-4">
      ${offers.length === 0 ? '' : '<h2 class="h6">New job offers</h2>'}
      ${offers.map((offer) => offerMarkup(offer, state)).join('')}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

function secondsLeft(offer, now) {
  return Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000));
}

function offerMarkup(offer, state) {
  const remaining = secondsLeft(offer, state.now);
  const urgent = remaining <= URGENT_SECONDS;
  const offline = !state.outbox.online;

  return `
    <div class="card offer-card ${urgent ? 'offer-urgent' : ''} mb-2" data-offer-id="${escapeText(offer.offerId)}">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div>
            <p class="h5 mb-1">${escapeText(offer.vehicle)}</p>
            <p class="mb-0 small">${escapeText(offer.zone)}${offer.where ? ` · ${escapeText(offer.where)}` : ''}</p>
          </div>
          <span class="badge ${offer.safetyLevel === 'HIGH_RISK' ? 'bg-danger' : 'bg-secondary'}">
            ${escapeText(safetyWords(offer.safetyLevel))}
          </span>
        </div>
        <p class="countdown mb-2">${remaining} seconds left to answer</p>
        ${
          offline
            ? '<p class="small mb-0">You are offline. An offer expires in under a minute, so it cannot be answered from the queue — reconnect to accept.</p>'
            : `<div class="d-flex gap-2">
                 <button class="btn btn-success btn-lg flex-grow-1" data-accept="${escapeText(offer.offerId)}">Accept</button>
                 <button class="btn btn-outline-light btn-lg" data-decline="${escapeText(offer.offerId)}">Decline</button>
               </div>`
        }
      </div>
    </div>`;
}

// The safety level in words. A technician IS an operator and may see the
// vocabulary — but "high risk" reads faster than an underscore at arm's length
// in daylight.
function safetyWords(level) {
  if (level === 'HIGH_RISK') return 'high risk';
  if (level === 'ELEVATED') return 'take care';
  return 'routine';
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
