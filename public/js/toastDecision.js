// WHEN TO SHOW A TOAST — the decision, with no DOM in it.
//
// Split out of panels/toast.js so it can be tested. The panel still owns the
// element, the timer and the wording; this owns the one question that was
// actually wrong, twice over:
//
//   1. It keyed off `recentResults()`, which the offline queue only appends to
//      when the SERVER answers. So the case that most needs a toast — a tap
//      that went into the queue with no signal and changed nothing on screen —
//      produced nothing at all, which is exactly the dead-button feeling the
//      toast exists to prevent.
//   2. It read the LAST element of `results`, and results are newest-FIRST. So
//      even the case it did handle announced the oldest answer it still had.
//
// Both were invisible because a toast is a transient thing nobody was asserting
// on. A pure function is: tests/toast.test.ts covers each branch, including the
// queued one that produced nothing.
//
// THE SHAPE. `previous` is what the last call saw; `next` is what this render
// sees. It returns the toast to show, or null, plus the `previous` to carry
// forward — so the caller holds no logic of its own.

/**
 * @param {{ pendingCount: number, resultKey: string | null, primed: boolean }} previous
 * @param {{ pendingCount: number, resultKey: string | null, step?: string | null }} next
 */
export function decideToast(previous, next) {
  const carry = {
    pendingCount: next.pendingCount,
    resultKey: next.resultKey,
    primed: true,
  };

  // THE FIRST CALL PRIMES RATHER THAN ANNOUNCES. A page loaded with a queue
  // already on disk from a previous session, or with a history of results,
  // must not fire a toast for something that happened yesterday.
  if (!previous.primed) return { toast: null, next: carry };

  // A SERVER ANSWER WINS OVER A QUEUED TAP. When a drain succeeds both can move
  // in the same tick — the item leaves `pending` as its result is appended —
  // and "it sent" is the better news of the two.
  if (next.resultKey !== null && next.resultKey !== previous.resultKey) {
    return { toast: { kind: 'sent', step: next.step ?? null }, next: carry };
  }

  // NOTHING CAME BACK, BUT SOMETHING WAS TAKEN. This is the branch that did not
  // exist. `pending` growing with no new result is precisely "we have your tap
  // and it has not gone anywhere yet".
  if (next.pendingCount > previous.pendingCount) {
    return { toast: { kind: 'queued', step: null }, next: carry };
  }

  return { toast: null, next: carry };
}

// The starting point for a page that has just loaded. Deliberately unprimed:
// see the note above.
export function initialToastState() {
  return { pendingCount: 0, resultKey: null, primed: false };
}

// One key per answer, so a repeated identical response does not re-announce
// itself on every render while a different one always does.
export function resultKeyOf(result) {
  if (!result) return null;
  return `${result.step ?? ''}:${result.outcome ?? ''}:${result.detail ?? ''}`;
}
