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

const VISIBLE_MS = 4000;

let shownKey = null;
let hideTimer = null;

export function render(state) {
  const results = state.outbox?.results ?? [];
  const latest = results[results.length - 1];
  if (!latest) return;

  // One toast per result. Without this every render would re-show the same
  // confirmation and it would never go away.
  const key = `${latest.idempotencyKey ?? latest.key ?? ''}:${latest.outcome ?? latest.status ?? ''}`;
  if (key === shownKey) return;
  shownKey = key;

  show(latest);
}

function show(result) {
  const queued = result.queued === true || result.outcome === 'QUEUED';
  const node = document.querySelector('[data-panel="toast"]') ?? create();

  node.className = `toast${queued ? ' is-queued' : ''}`;
  node.innerHTML = `${icon(queued ? 'clock' : 'check', 'icon icon-sm')}<span></span>`;
  node.querySelector('span').textContent = queued
    ? 'Saved. It will send when you have signal.'
    : wordFor(result);
  node.hidden = false;

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

function wordFor(result) {
  return STEP_WORD[result.step ?? result.kind] ?? 'Sent.';
}

function create() {
  const node = document.createElement('div');
  node.dataset.panel = 'toast';
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.hidden = true;
  document.body.append(node);
  return node;
}
