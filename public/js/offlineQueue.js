// THE OFFLINE QUEUE — the technician's phone, with no signal.
//
// A technician works in basement car parks and under flyovers. They tap "on my
// way", "arrived", "diagnosing", "working" over ten minutes with nothing on
// the bars, and every one of those taps has to land, exactly once, in the
// order they happened.
//
// THREE RULES, AND THEY ARE THE WHOLE DESIGN.
//
// 1. EVERY ACTION IS QUEUED. There is no online path and offline path — the
//    online case is this queue draining immediately. One code path means the
//    offline behaviour is exercised on every single tap rather than only when
//    the network happens to be down, which is the difference between a feature
//    that works and one that has never been run.
//
// 2. THE KEY IS MINTED AT THE TAP. `crypto.randomUUID()` is called once, when
//    the technician's finger comes off the button, and stored with the action.
//    Every retry of that action sends the SAME key, which is what lets the
//    server recognise a replay (src/commit/technicianActions.ts). A key
//    generated at send time would be a new key on every retry and would
//    guarantee exactly the double-transition this exists to prevent.
//
// 3. STRICTLY IN ORDER, ONE AT A TIME. The head of the queue is sent and
//    awaited before the next is touched. Firing them in parallel would let
//    "arrived" land before "on my way", and while the server's ladder is
//    monotonic and would survive that, the JobEvent trail the driver reads
//    would be out of order — and that trail is the product.
//
// PERSISTED IN localStorage, because the tab will be backgrounded and the
// phone will be locked. A queue that only lives in memory loses everything at
// the moment it is most needed.
//
// WHAT IS NOT QUEUED: accepting or declining an offer. An offer expires in
// forty-five seconds, so answering one from a queue that drains ten minutes
// later would accept a job somebody else was long since sent to. The page says
// so instead of pretending.

const QUEUE_KEY = 'zippy.technician.queue';
const SEQUENCE_KEY = 'zippy.technician.sequence';

// Set by the page at startup: how to send one action, and what to do after the
// queue changes. Injected rather than imported so this file knows nothing
// about the API or about rendering.
let sendAction = null;
let onChange = () => {};
let draining = false;

export function configureQueue(options) {
  sendAction = options.send;
  onChange = options.onChange ?? (() => {});
}

function read() {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    // A corrupt or unavailable store must not brick the page. An empty queue
    // is the safe reading: the server is the record of what happened, and the
    // worst case is the technician re-taps.
    return [];
  }
}

function write(queue) {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Private mode, or the quota is full. Nothing to do but carry on in
    // memory for this session.
  }
}

export function pending() {
  return read();
}

// The phone's own counter, persisted so it keeps climbing across reloads. It
// is not trusted by the server for anything — it is recorded there so the
// order the taps actually happened in is auditable after the fact.
function nextSequence() {
  const current = Number(window.localStorage.getItem(SEQUENCE_KEY) ?? '0');
  const next = Number.isFinite(current) ? current + 1 : 1;
  try {
    window.localStorage.setItem(SEQUENCE_KEY, String(next));
  } catch {
    // See write().
  }
  return next;
}

// One tap. Called by the ladder buttons and by the completion-code form; both
// go through here, never straight to the API.
export function enqueue(action) {
  const queue = read();
  queue.push({
    idempotencyKey: crypto.randomUUID(),
    clientSequence: nextSequence(),
    // When the technician tapped, not when we manage to send it. The server
    // stores both and the gap between them IS the offline period.
    eventTime: new Date().toISOString(),
    jobId: action.jobId,
    step: action.step,
    completionCode: action.completionCode,
    // What the server said, once it has said anything. Kept on the item so the
    // page can show the answer to the tap the technician actually made.
    result: null,
  });
  write(queue);
  onChange();
  drain();
}

// Send the head, await it, then the next. Never in parallel, never skipping.
export async function drain() {
  if (draining || !sendAction) return;
  draining = true;

  try {
    while (read().length > 0) {
      if (!navigator.onLine) break;

      const queue = read();
      const head = queue[0];

      let response;
      try {
        response = await sendAction(head);
      } catch (error) {
        // A NETWORK failure leaves the item at the head and stops the drain —
        // it will go again on the next `online` event or the next tap. A 4xx
        // is NOT a network failure: the server answered, and the answer counts
        // (see below), so only a thrown fetch reaches here.
        if (error.status === undefined) break;
        response = { outcome: 'REJECTED', detail: error.message };
      }

      // The item leaves the queue on ANY answer, including a rejection. The
      // server answers 200 for every outcome precisely so this is unambiguous:
      // a rejection is a final answer, and an item retried forever because it
      // was refused is a queue that never drains.
      const remaining = read();
      remaining.shift();
      write(remaining);
      recordResult(head, response);
      onChange();
    }
  } finally {
    draining = false;
  }
}

// The last few answers, so the technician can see what happened to the taps
// they made while offline rather than watching them vanish silently.
const RESULT_HISTORY = 6;
let results = [];

function recordResult(item, response) {
  results = [
    { step: item.step, outcome: response.outcome, detail: response.detail },
    ...results,
  ].slice(0, RESULT_HISTORY);
}

export function recentResults() {
  return results;
}

// Two triggers, both cheap: coming back online, and loading the page with a
// queue already on disk from a previous session.
export function watchConnectivity() {
  window.addEventListener('online', () => {
    onChange();
    drain();
  });
  window.addEventListener('offline', onChange);
  drain();
}
