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

// Two different things to confirm, and they come from two different places —
// which is the bug the first version of this file had. `recentResults()` is
// only appended when the SERVER answers, so keying the toast off it meant the
// one case that actually needs a toast — a tap that went into the queue and
// changed nothing on screen — produced nothing at all. And the results array is
// newest-FIRST, so reading the last element showed the oldest answer.
//
//   pending grows   -> "Saved. It will send when you have signal."
//   results[0] new  -> "On your way." (the server took it)
let lastPending = 0;
let lastResultKey = null;
let hideTimer = null;
let primed = false;

export function render(state) {
  const outbox = state.outbox;
  if (!outbox) return;

  const pendingCount = outbox.pending?.length ?? 0;
  const newest = outbox.results?.[0] ?? null;
  const resultKey = newest ? `${newest.step}:${newest.outcome}:${newest.detail ?? ''}` : null;

  // THE FIRST RENDER PRIMES RATHER THAN ANNOUNCES. A page loaded with a queue
  // already on disk from a previous session, or with a history of results,
  // should not fire a toast for something that happened yesterday.
  if (!primed) {
    primed = true;
    lastPending = pendingCount;
    lastResultKey = resultKey;
    return;
  }

  if (resultKey && resultKey !== lastResultKey) {
    lastResultKey = resultKey;
    lastPending = pendingCount;
    show({ queued: false, step: newest.step });
    return;
  }

  if (pendingCount > lastPending) {
    lastPending = pendingCount;
    show({ queued: true });
    return;
  }

  lastPending = pendingCount;
}

function show({ queued, step }) {
  const node = document.querySelector('[data-panel="toast"]') ?? create();

  node.className = `toast${queued ? ' is-queued' : ''}`;
  node.innerHTML = `${icon(queued ? 'clock' : 'check', 'icon icon-sm')}<span></span>`;
  node.querySelector('span').textContent = queued
    ? 'Saved. It will send when you have signal.'
    : STEP_WORD[step] ?? 'Sent.';
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

function create() {
  const node = document.createElement('div');
  node.dataset.panel = 'toast';
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.hidden = true;
  document.body.append(node);
  return node;
}
