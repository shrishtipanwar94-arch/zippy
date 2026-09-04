// "THAT WORKED." — the confirmation an offline queue makes necessary.
//
// WHY THIS MATTERS MOST HERE. A technician taps a rung with no signal. The tap
// goes into the queue, the request does not leave the phone, and the card does
// not change — because nothing has changed yet. Without a word from the screen
// that is indistinguishable from a dead button, so the reasonable thing to do
// is tap it again, and again.
//
// Two states, and the difference is the whole point:
//   QUEUED  we have your tap and it will send when there is signal
//   SENT    it reached the server and the job actually moved
//
// It reads `state.outbox.results`, which the offline queue already publishes —
// nothing new is recorded to make this work.
//
// IT DISMISSES ITSELF because it is a confirmation, not a decision. A toast
// that needs closing is a dialog wearing a costume. Anything a technician has
// to ACT on is a card in the page, never this.

import { icon } from '../icons.js';
import { decideToast, initialToastState, resultKeyOf } from '../toastDecision.js';

const VISIBLE_MS = 4000;

// THE DECISION LIVES IN js/toastDecision.js, with no DOM in it, because the
// branch that was wrong is a decision rather than a rendering: a queued tap
// appends no result, so keying off results alone produced nothing in exactly
// the case a toast exists for. tests/toast.test.ts covers it.
//
// What is left here is the element, the timer and the wording.
let seen = initialToastState();
let hideTimer = null;

export function render(state) {
  const outbox = state.outbox;
  if (!outbox) return;

  const newest = outbox.results?.[0] ?? null;
  const { toast, next } = decideToast(seen, {
    pendingCount: outbox.pending?.length ?? 0,
    resultKey: resultKeyOf(newest),
    step: newest?.step ?? null,
  });
  seen = next;

  if (toast) show(toast);
}

function show(toast) {
  const queued = toast.kind === 'queued';
  const node = document.querySelector('[data-panel="toast"]') ?? create();

  node.className = `toast${queued ? ' is-queued' : ''}`;
  node.innerHTML = `${icon(queued ? 'clock' : 'check', 'icon icon-sm')}<span></span>`;
  node.querySelector('span').textContent = queued
    ? 'Saved. It will send when you have signal.'
    : (STEP_WORD[toast.step] ?? 'Sent.');
  node.hidden = false;

  // IT DISMISSES ITSELF because it is a confirmation, not a decision. A toast
  // that needs closing is a dialog wearing a costume; anything a technician has
  // to ACT on is a card in the page, never this.
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    node.hidden = true;
  }, VISIBLE_MS);
}

// The step in the words the button used, so the confirmation echoes what was
// pressed rather than naming a rung nobody typed.
const STEP_WORD = {
  EN_ROUTE: 'On your way.',
  ARRIVED: 'Arrival recorded.',
  DIAGNOSING: 'Diagnosis started.',
  WORKING: 'Work started.',
  COMPLETE: 'Job finished.',
  PARTS: 'Parts recorded.',
};

function create() {
  const node = document.createElement('div');
  node.dataset.panel = 'toast';
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.hidden = true;
  document.body.append(node);
  return node;
}
