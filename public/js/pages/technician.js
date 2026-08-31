// The technician page. Offers with a live deadline, the job in hand, and the
// offline queue that every action goes through.
//
// TWO CLOCKS RUN HERE and they do different jobs. `tickClock` updates
// `state.now` once a second so an offer countdown is derived rather than
// decremented. The socket delivers job events, which is what makes the ladder
// and the trail current without polling.
//
// NO BUTTON CALLS THE API DIRECTLY except the offer response. Ladder actions
// and the completion code go into the offline queue and drain from there, so
// the offline path runs on every tap instead of only when the signal drops.

import {
  getState,
  onJobEvent,
  registerPanel,
  render,
  setActiveJob,
  setError,
  setJobs,
  setOutbox,
  setSession,
  setWork,
  tickClock,
} from '../state.js';
import * as api from '../api.js';
import { configureQueue, drain, enqueue, pending, recentResults, watchConnectivity } from '../offlineQueue.js';
import { connect, subscribeToJob } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderOffers } from '../panels/technicianOffer.js';
import { render as renderLadder, renderOutbox } from '../panels/technicianLadder.js';
import { render as renderJobDetail } from '../panels/jobDetail.js';

registerPanel(renderSession);
registerPanel(renderOutbox);
registerPanel(renderOffers);
registerPanel(renderLadder);
registerPanel(renderJobDetail);

function value(selector) {
  return document.querySelector(selector)?.value.trim() ?? '';
}

// The queue's view of the world, mirrored into state so panels render it the
// same way they render everything else.
function syncOutbox() {
  setOutbox({ pending: pending(), results: recentResults(), online: navigator.onLine });
}

configureQueue({
  send: api.sendTechnicianAction,
  onChange: () => {
    syncOutbox();
    render();
    // An applied action changed the job on the server; re-read the board so
    // the ladder shows the rung that is actually next.
    refreshWork();
  },
});

async function refreshWork() {
  if (!getState().token) return;
  try {
    const work = await api.getTechnicianWork();
    setWork(work);
    // The event trail and the job list are two different reads of the same
    // jobs; keeping the table's copy in step means jobDetail.js needs no
    // special case.
    setJobs(work.jobs.map((job) => ({ id: job.jobId, status: job.status, safetyLevel: job.safetyLevel })));
    for (const job of work.jobs) subscribeToJob(job.jobId);
    for (const offer of work.offers) subscribeToJob(offer.jobId);
    if (!getState().activeJobId && work.jobs.length > 0) setActiveJob(work.jobs[0].jobId);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
}

onJobEvent(() => refreshWork());

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, { role: result.user.role, userId: result.user.id });
    connect();
    syncOutbox();
    watchConnectivity();
    await refreshWork();
  } catch (error) {
    setError(error.message);
  }
  render();
});

// Offers. Delegated because the cards are rebuilt every second as the
// countdown moves, and a listener bound to a replaced element is a leak.
document.querySelector('[data-panel="offers"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('button[data-accept], button[data-decline]');
  if (!button) return;

  const offerId = button.dataset.accept ?? button.dataset.decline;
  const decision = button.dataset.accept ? 'ACCEPTED' : 'DECLINED';
  try {
    await api.respondToOffer(offerId, decision);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await refreshWork();
});

// The ladder, the completion code and the diagnosis form.
document.querySelector('[data-panel="ladder"]').addEventListener('click', async (clicked) => {
  const stepButton = clicked.target.closest('button[data-step]');
  if (stepButton) {
    const step = stepButton.dataset.step;
    // Read the code BEFORE enqueuing: the input is inside the card, and the
    // card is rebuilt the moment the queue changes.
    const completionCode = step === 'COMPLETE' ? value('#completion-code') : undefined;
    enqueue({ jobId: stepButton.dataset.jobId, step, completionCode });
    return;
  }

  const diagnoseButton = clicked.target.closest('button[data-diagnose]');
  if (!diagnoseButton) return;
  try {
    await api.submitDiagnosis(
      diagnoseButton.dataset.diagnose,
      document.querySelector('[data-field="diagnosis-complaint"]').value,
    );
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await refreshWork();
});

// One second is fine: the countdown is whole seconds, and deriving it from the
// clock means a missed tick shows the right number rather than a stale one.
setInterval(() => {
  tickClock();
  render();
}, 1000);

// A queue left on disk from a previous session drains as soon as the page can
// send anything.
window.addEventListener('online', () => {
  syncOutbox();
  drain();
});
window.addEventListener('offline', () => {
  syncOutbox();
  render();
});

syncOutbox();
render();
