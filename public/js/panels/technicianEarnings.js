// WHAT I AM OWED — the technician's own ledger, on their own phone.
//
// Phase 15c built the earnings model and Phase 22b built the rail that pays it
// out. Between them, the person earning the money had no way to look at it:
// `technicianBalance` existed with no route, and this page had no view at all.
//
// THE NEGATIVE BALANCE IS WHY THIS IS A STATEMENT AND NOT A NUMBER. A
// technician who takes cash from a driver is holding money that is mostly not
// theirs, so their balance goes negative by roughly the platform's commission.
// A bare "-₹468" on a phone reads as a fine. The server sends a sentence for
// each of the three standings (src/commit/technicianEarnings.ts) and this panel
// shows it directly rather than inventing its own wording — the same rule the
// driver's page follows about who owns the words.
//
// A DEBT IS NOT SHOWN IN RED. Red on this page means HIGH_RISK or a failure,
// and owing the platform its share of collected cash is neither: it is the
// ordinary consequence of taking cash, and it settles itself out of the next
// job. Amber, with the explanation next to it.

const STANDING_LABEL = {
  PAY: 'Due in the next payout',
  HOLD_BELOW_MINIMUM: 'Rolling over',
  CARRY_DEBT: 'Netted off your next earnings',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="earnings"]');
  if (!panel) return;

  const earnings = state.earnings;
  const markup = `
    <div data-panel="earnings" class="mt-2">
      ${earnings ? statementMarkup(earnings) : '<p class="text-secondary mb-0">Not loaded.</p>'}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

function statementMarkup(earnings) {
  const owing = earnings.balancePaise < 0;

  return `
    <div class="card ${owing ? 'balance-owing' : 'balance-due'}">
      <div class="card-body">
        <div class="text-secondary small">${owing ? 'You are holding' : 'Your balance'}</div>
        <p class="balance-figure mb-1">${escapeText(rupees(Math.abs(earnings.balancePaise)))}</p>
        <p class="mb-2">
          <span class="badge ${owing ? 'text-bg-warning' : 'text-bg-success'}">
            ${escapeText(STANDING_LABEL[earnings.standing] ?? earnings.standing)}
          </span>
        </p>
        <p class="small mb-3">${escapeText(earnings.explanation)}</p>

        ${pendingMarkup(earnings.pendingPayouts)}

        <h3 class="h6 text-secondary">Recent</h3>
        <ul class="list-unstyled small mb-0">
          ${
            earnings.entries.length === 0
              ? '<li class="text-secondary">Nothing on your account yet.</li>'
              : earnings.entries.map(entryMarkup).join('')
          }
        </ul>
      </div>
    </div>`;
}

// A PAYOUT ALREADY ON ITS WAY. SENT is not PAID — the rail has accepted it and
// the money has not landed — and saying "paid" for a transfer still in flight is
// exactly the claim src/commit/payoutExecution.ts refuses to make.
function pendingMarkup(payouts) {
  if (payouts.length === 0) return '';
  return `
    <div class="mb-3">
      <h3 class="h6 text-secondary">On its way</h3>
      <ul class="list-unstyled small mb-0">
        ${payouts.map(payoutMarkup).join('')}
      </ul>
    </div>`;
}

// ONE PAYOUT, WITH THE BATCH IT WENT OUT IN. The reference is the string a
// technician quotes when a transfer has not landed — to the office, or to their
// bank — and src/commit/technicianEarnings.ts has always sent it while this
// panel rendered only the status and the amount. Without it "sent to your bank"
// is an assertion nobody can chase.
//
// Null for a payout not yet in a batch, which is the honest case rather than a
// missing one: it has not been through a run, so there is no reference to give.
function payoutMarkup(payout) {
  const reference = payout.reference
    ? `<div class="text-secondary payout-ref">${escapeText(payout.reference)}</div>`
    : '';
  return `
    <li class="d-flex justify-content-between gap-2 py-1">
      <span>
        ${escapeText(payout.status === 'SENT' ? 'Sent to your bank' : 'Queued for the next run')}
        ${reference}
      </span>
      <span class="text-nowrap">${escapeText(rupees(payout.amountPaise))}</span>
    </li>`;
}

// The sign is carried by a word as well as by the figure — "earned" or "held" —
// because a minus sign is easy to miss on a bright screen and colour is never
// the only signal.
function entryMarkup(entry) {
  const negative = entry.amountPaise < 0;
  return `
    <li class="d-flex justify-content-between gap-2 py-1">
      <span>${escapeText(entry.memo)}</span>
      <span class="text-nowrap">
        ${escapeText(negative ? '−' : '+')}${escapeText(rupees(Math.abs(entry.amountPaise)))}
      </span>
    </li>`;
}

// RUPEES, THE SAME WAY src/domain/money.ts DOES IT — no trailing ".00" on a
// whole rupee. Almost every price in this catalogue is whole rupees, and two
// decimal places that are always zero are two more characters between a
// technician and the number they are looking for.
//
// A second copy of a formatting rule is exactly the hazard this codebase keeps
// finding, so it is spelled the same on purpose: if the server's rule changes,
// this is the other place to change.
function rupees(paise) {
  const value = paise / 100;
  const fractionDigits = Number.isInteger(value) ? 0 : 2;
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2,
  })}`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
