// WHAT TODAY HAS BEEN WORTH — one figure, on the surface.
//
// The full statement is behind a disclosure and answers a different question:
// the running BALANCE is what will be paid out, which legitimately goes
// negative when a technician is holding cash that is mostly the platform's.
// That is the right thing to explain carefully and the wrong thing to lead
// with. What somebody sitting in a van between jobs wants is whether today has
// been any good, and that number needed a tap and a read down a list of ledger
// memos to find — so in practice nobody found it.
//
// THE RECEIPT COMPONENT, so the same money looks the same everywhere. The
// figure is mono and tabular, like every other amount in the product.
//
// The server owns the arithmetic (src/commit/technicianEarnings.ts), including
// where the day starts — IST, so a job finished at 1am counts on the day it was
// worked rather than the day UTC thinks it is.

import { icon } from '../icons.js';

export function render(state) {
  const panel = document.querySelector('[data-panel="today"]');
  if (!panel) return;

  const earnings = state.earnings;
  // Hidden rather than showing a zero before the first load answers. "₹0" and
  // "we have not looked yet" are different facts and only one of them is
  // discouraging.
  panel.hidden = !earnings;
  if (!earnings) return;

  const jobs = earnings.jobsToday === 1 ? '1 job' : `${earnings.jobsToday} jobs`;

  const markup = `
    <div data-panel="today" class="mb-4 today-card">
      <p class="section-head mb-2">${icon('rupee', 'icon icon-sm')} Today</p>
      <div class="receipt">
        <div class="receipt-total">
          <span>Earned today</span>
          <span class="amount">${escapeText(rupees(earnings.todayPaise))}</span>
        </div>
        <div class="receipt-row is-muted">
          <span>${escapeText(jobs)} finished</span>
        </div>
      </div>
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

// The same rule src/domain/money.ts follows — no trailing ".00" on a whole
// rupee. Spelled the same in both places on purpose: if one changes, this is
// the other one to change.
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
