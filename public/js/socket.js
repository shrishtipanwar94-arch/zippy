// The WebSocket side. One connection per page, opened once the page has a
// token, and the only writer into state besides the initial HTTP load.
//
// The Socket.IO browser client is served by our own server at
// /socket.io/socket.io.js — it does not come from a CDN, because the server
// already ships a version-matched copy and a mismatched client is a confusing
// failure.
//
// THE TOKEN GOES IN `auth`, NOT THE URL. It is verified on the handshake, so a
// bad token never becomes a socket, and it stays out of proxy logs and browser
// history.
//
// POLLING IS THE FALLBACK, NOT THE DESIGN (Phase 17). When the socket cannot
// connect — the server refused the handshake, the network is gone, the fan-out
// cache is down — this file starts a timer that refetches instead, and stops
// it the moment a socket comes back. The console keeps working; it just finds
// out later. Socket.IO's own reconnect loop is what makes the recovery
// automatic: nobody has to press anything, which is the phase's actual
// requirement.

import {
  applyJobEvent,
  cursorFor,
  getState,
  notifyJobEvent,
  pushChatMessage,
  pushPromotion,
  removePromotion,
  setNotification,
  pushTimelineEvent,
  render,
  resetJobHistory,
  setConnection,
} from './state.js';

let socket = null;
// Jobs this page has asked for, so a reconnect can resubscribe to all of them
// with the cursor each one reached.
const subscribed = new Set();

export function connect() {
  const { token } = getState();
  if (!token || socket) return;

  setConnection('connecting');
  render();

  // eslint-disable-next-line no-undef
  socket = io({ auth: { token }, transports: ['websocket'] });

  socket.on('connect', () => {
    setConnection('connected');
    stopPolling();
    // On a RECONNECT this resubscribes every job with the cursor it reached,
    // which is what makes a dropped connection recoverable rather than a
    // reload. On a first connect the cursors are 0 and it replays everything.
    for (const jobId of subscribed) {
      sendSubscribe(jobId);
    }
    render();
  });

  socket.on('disconnect', () => {
    setConnection('disconnected');
    startPolling();
    render();
  });

  // A refused handshake is the interesting case: the server is up and saying
  // no (live updates switched off, or the fan-out cache unreachable). It looks
  // identical to a network failure from here, and gets the same answer.
  socket.on('connect_error', () => {
    setConnection('disconnected');
    startPolling();
    render();
  });

  socket.on('job:event', (event) => {
    // TWO CONSUMERS, ONE MESSAGE. `applyJobEvent` maintains the per-job history
    // and the jobs table; `pushTimelineEvent` maintains the console's incident
    // feed. Both are called unconditionally and each reports whether it changed
    // anything, because `||` would short-circuit and skip the second.
    const jobChanged = applyJobEvent(event);
    const timelineChanged = pushTimelineEvent(event);
    // A THIRD CONSUMER, and the only one that is not a state write. The
    // driver's panel is worded by the server, so an event means "re-read the
    // driver view" rather than "patch this object". See state.onJobEvent.
    notifyJobEvent(event.jobId);
    if (jobChanged || timelineChanged) render();
  });

  // CHAT, PROMOTIONS AND NOTIFICATIONS — Phase 15b. Three more messages on the
  // same socket, delivered to the JOB ROOM only (see realtime/publish.ts for
  // why they do not go to the zone room the way job events do).
  socket.on('chat:message', (message) => {
    if (pushChatMessage(message)) render();
  });

  // WHERE THE VAN IS. Job room only, and the room choice matters more here than
  // anywhere else on this socket: this is a person's live whereabouts while
  // they are at work, and the only party with a claim on it is the driver
  // waiting for them. See realtime/publish.ts.
  //
  // It calls the same hook a job event does rather than patching state
  // directly. The driver's panel is worded by the server, so "a position
  // arrived" means "re-read the driver view" — the alternative is this file
  // holding a second copy of the staleness rule.
  socket.on('unit:position', (position) => {
    notifyJobEvent(position.jobId);
  });

  // A flagged message arriving for whoever must confirm it. NOTHING HAS
  // CHANGED on the job when this lands — that is the whole design, and the
  // card this renders is the human in the middle.
  socket.on('promotion:flagged', (promotion) => {
    if (pushPromotion(promotion)) render();
  });

  socket.on('promotion:resolved', (resolved) => {
    removePromotion(resolved.promotionId);
    render();
  });

  // ONE per re-plan, after the plan has settled. See workers/notification.ts.
  socket.on('notification:new', (notification) => {
    setNotification(notification);
    render();
  });

  socket.on('job:replay', (replay) => {
    // A truncated replay means we missed more than the server will send. The
    // history we hold is unreliable, so it is dropped rather than shown with a
    // hole in it; the next full page load rebuilds it.
    if (replay.truncated) {
      resetJobHistory(replay.jobId);
      render();
      return;
    }

    let changed = false;
    for (const event of replay.events) {
      // Same two consumers as the live path. A replayed event carries the same
      // shape as a live one (realtime/replay.ts fills in zone and safety
      // precisely so this branch does not have to differ), and the timeline
      // de-duplicates by (job, sequence) so an overlap with the live stream is
      // absorbed rather than doubled.
      if (applyJobEvent(event)) changed = true;
      if (pushTimelineEvent(event)) changed = true;
    }
    if (replay.events.length > 0) notifyJobEvent(replay.jobId);
    if (changed) render();
  });
}

// --- the polling fallback ---------------------------------------------------
//
// Five seconds: slow enough that a console left open on a broken connection is
// not a load test, fast enough that a dispatcher does not think the board has
// frozen. The callback is registered by the page, because what is worth
// refetching differs between the dispatcher's board and the driver's panel and
// this file has no business knowing either.

const POLL_INTERVAL_MS = 5000;
let pollTimer = null;
let pollCallback = null;

export function onPoll(callback) {
  pollCallback = callback;
}

function startPolling() {
  if (pollTimer || !pollCallback) return;
  pollTimer = setInterval(() => void pollCallback(), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function sendSubscribe(jobId) {
  socket.emit('job:subscribe', { jobId, lastEventSequence: cursorFor(jobId) });
}

export function subscribeToJob(jobId) {
  subscribed.add(jobId);
  if (socket && socket.connected) sendSubscribe(jobId);
}
