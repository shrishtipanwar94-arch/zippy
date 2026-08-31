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

import {
  applyJobEvent,
  cursorFor,
  getState,
  notifyJobEvent,
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

function sendSubscribe(jobId) {
  socket.emit('job:subscribe', { jobId, lastEventSequence: cursorFor(jobId) });
}

export function subscribeToJob(jobId) {
  subscribed.add(jobId);
  if (socket && socket.connected) sendSubscribe(jobId);
}
