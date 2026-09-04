// WHEN THE TECHNICIAN'S PHONE SAYS "THAT WORKED".
//
// This is a browser module, tested from Node, and it is worth saying why it is
// worth the hand-written declaration file next to it: the toast shipped twice
// with the same class of bug, and both times the suite went from green to green
// because nothing asserted on it.
//
//   FIRST WRONG: it keyed off the offline queue's `recentResults()`, which is
//   only appended when the SERVER answers. So a tap made with no signal — which
//   goes into the queue, sends nothing and changes nothing on screen — produced
//   no toast at all. That is precisely the case the toast exists for: without
//   it a queued tap is indistinguishable from a dead button, and the reasonable
//   thing to do is tap again.
//
//   SECOND WRONG: it read `results[results.length - 1]`, and the queue prepends
//   — so even the case it did handle announced the oldest answer it still held
//   rather than the newest.
//
// The decision is a pure function precisely so these are three lines of test
// each rather than a browser session and a stopwatch.

import { describe, expect, it } from 'vitest';
import {
  decideToast,
  initialToastState,
  resultKeyOf,
} from '../public/js/toastDecision.js';

// A primed starting point — the state after one render has already happened,
// which is where every case below except the priming test begins.
function primed(pendingCount = 0, resultKey: string | null = null) {
  return { pendingCount, resultKey, primed: true };
}

describe('the toast decides what to announce', () => {
  // THE BRANCH THAT DID NOT EXIST, and the reason this file does.
  it('fires for a queued action even though it appends no result', () => {
    const { toast } = decideToast(primed(0, null), { pendingCount: 1, resultKey: null });

    expect(toast).toEqual({ kind: 'queued', step: null });
  });

  // The same condition stated the other way round: it is the GROWTH of the
  // queue that matters, not its size. A page that loads with three items
  // already waiting has not just had a tap.
  it('does not fire when a queue that was already full stays full', () => {
    const { toast } = decideToast(primed(3, null), { pendingCount: 3, resultKey: null });

    expect(toast).toBeNull();
  });

  it('does not fire when the queue drains', () => {
    const { toast } = decideToast(primed(2, null), { pendingCount: 1, resultKey: null });

    expect(toast).toBeNull();
  });

  it('announces a server answer, naming the step that was taken', () => {
    const { toast } = decideToast(primed(1, null), {
      pendingCount: 0,
      resultKey: 'EN_ROUTE:APPLIED:recorded',
      step: 'EN_ROUTE',
    });

    expect(toast).toEqual({ kind: 'sent', step: 'EN_ROUTE' });
  });

  // A drain moves both counters in one tick — the item leaves `pending` exactly
  // as its result is appended — and "it sent" is the better news of the two.
  it('prefers the server answer when a result and the queue move together', () => {
    const { toast } = decideToast(primed(0, null), {
      pendingCount: 1,
      resultKey: 'ARRIVED:APPLIED:recorded',
      step: 'ARRIVED',
    });

    expect(toast).toEqual({ kind: 'sent', step: 'ARRIVED' });
  });

  it('does not re-announce an answer it has already shown', () => {
    const state = primed(0, 'WORKING:APPLIED:recorded');
    const { toast } = decideToast(state, {
      pendingCount: 0,
      resultKey: 'WORKING:APPLIED:recorded',
      step: 'WORKING',
    });

    expect(toast).toBeNull();
  });

  // A page reloaded with a queue on disk from a previous session, or with a
  // history of results, must not announce something that happened yesterday.
  it('primes on the first render rather than announcing', () => {
    const { toast, next } = decideToast(initialToastState(), {
      pendingCount: 4,
      resultKey: 'COMPLETE:APPLIED:recorded',
      step: 'COMPLETE',
    });

    expect(toast).toBeNull();
    expect(next.primed).toBe(true);
    // And it carries what it saw, so the NEXT tap is measured against reality
    // rather than against zero.
    expect(next.pendingCount).toBe(4);
  });

  it('announces the next tap after priming', () => {
    const first = decideToast(initialToastState(), { pendingCount: 1, resultKey: null });
    const second = decideToast(first.next, { pendingCount: 2, resultKey: null });

    expect(first.toast).toBeNull();
    expect(second.toast).toEqual({ kind: 'queued', step: null });
  });
});

// THE KEY IS WHAT MAKES "ALREADY SHOWN" ANSWERABLE. Two different answers to
// the same step have to look different, or the second one is silently swallowed
// as a repeat.
describe('resultKeyOf', () => {
  it('separates two different answers to the same step', () => {
    const applied = resultKeyOf({ step: 'ARRIVED', outcome: 'APPLIED', detail: 'recorded' });
    const rejected = resultKeyOf({ step: 'ARRIVED', outcome: 'REJECTED', detail: 'out of order' });

    expect(applied).not.toBe(rejected);
  });

  it('is null when there is no result at all', () => {
    expect(resultKeyOf(null)).toBeNull();
  });
});
