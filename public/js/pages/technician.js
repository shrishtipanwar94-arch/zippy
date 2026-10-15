// The technician page. Offers with a live deadline, the job in hand, and the
// offline queue that every action goes through.
//
// TWO CLOCKS RUN HERE and they do different jobs. `tickClock` updates
// `state.now` once a second so an offer countdown is derived rather than
// decremented. The socket delivers job events, which is what makes the ladder
// and the trail current without polling.
//
// NO BUTTON CALLS THE API DIRECTLY except the offer response and the van count.
// Ladder actions, the completion code and the parts declaration go into the
// offline queue and drain from there, so the offline path runs on every tap
// instead of only when the signal drops. The two exceptions are both online-
// only for the same kind of reason: an offer expires in forty-five seconds,
// and a count of the van is a thing somebody is doing while standing still.

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
  setCompletionParts,
  setEstimateInFlight,
  setVanCount,
  setVanStock,
  setWork,
  setEarnings,
  tickClock,
} from '../state.js';
import * as api from '../api.js';
import { configureQueue, drain, enqueue, pending, recentResults, watchConnectivity } from '../offlineQueue.js';
import { connect, subscribeToJob } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderOffers } from '../panels/technicianOffer.js';
import { render as renderLadder, renderOutbox } from '../panels/technicianLadder.js';
import { render as renderVanStock } from '../panels/vanStock.js';
// jobDetail.js is the DISPATCHER's raw audit panel and is deliberately no
// longer used here — see technicianUpdates.js for what replaced it and why.
import { render as renderUpdates } from '../panels/technicianUpdates.js';
import { render as renderRelease, dismissRelease } from '../panels/technicianRelease.js';
import { render as renderEarnings } from '../panels/technicianEarnings.js';
import { render as renderTechnicianMap } from '../panels/technicianMap.js';
import { render as renderToday } from '../panels/technicianToday.js';
import { render as renderToast } from '../panels/toast.js';
import { loadChat, registerChatPanels, wireChatActions } from '../chatActions.js';

registerPanel(renderSession);
registerPanel(renderOutbox);
registerPanel(renderOffers);
registerPanel(renderLadder);
// AFTER the ladder: the ladder renders the empty map container and tells
// morphdom to leave its subtree alone; this fills it.
registerPanel(renderTechnicianMap);
registerPanel(renderToday);
// Last: it confirms what the panels above have just finished showing.
registerPanel(renderToast);
registerPanel(renderVanStock);
registerPanel(renderUpdates);
registerPanel(renderRelease);
registerPanel(renderEarnings);
registerChatPanels();
wireChatActions();

function value(selector) {
  return document.querySelector(selector)?.value.trim() ?? '';
}

// The queue's view of the world, mirrored into state so panels render it the
// same way they render everything else.
function syncOutbox() {
  setOutbox({ pending: pending(), results: recentResults(), online: navigator.onLine });
}

// ONE QUEUE, TWO KINDS OF TAP. A ladder tap moves the job a rung; a parts tap
// declares what was fitted. Which endpoint an item goes to is decided here,
// where the API lives, rather than inside the queue — the queue's job is the
// key, the ordering and the retry, and it has never needed to know what any of
// its items mean.
function sendQueuedAction(action) {
  if (action.kind === 'PARTS') return api.declarePartsUsed(action);
  return api.sendTechnicianAction(action);
}

configureQueue({
  send: sendQueuedAction,
  onChange: () => {
    syncOutbox();
    render();
    // An applied action changed the job on the server; re-read the board so
    // the ladder shows the rung that is actually next.
    refreshWork();
    // And it may have changed the van: a parts declaration decrements a shelf,
    // and the screen showing that shelf is right here.
    refreshVanStock();
    // A completed job books earnings and a commission on the ledger, so the
    // balance on this same screen is stale the moment a rung lands.
    refreshEarnings();
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
    if (!getState().activeJobId && work.jobs.length > 0) {
      setActiveJob(work.jobs[0].jobId);
      await loadChat(work.jobs[0].jobId);
    }
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
}

// WHAT I AM OWED, read separately and failing separately. It is a running
// account rather than a fact about the job in hand, and a ledger read that
// fails must never blank the ladder somebody is working from — so it gets its
// own try and its own silence.
async function refreshEarnings() {
  if (!getState().token) return;
  try {
    setEarnings(await api.getTechnicianEarnings());
  } catch (error) {
    console.warn('could not load earnings', error);
  }
  render();
}

// ON DUTY OR OFF. Refetches the board rather than patching state locally: going
// off duty is a dispatch fact, and the board is where dispatch facts come from.
document.querySelector('[data-action="toggle-duty"]')?.addEventListener('click', async () => {
  const duty = getState().work.duty;
  if (!duty) return;
  try {
    await api.setDuty(!duty.onDuty);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await refreshWork();
  render();
});

// ACKNOWLEDGED BY THE PERSON. A release notice stays until it is pressed —
// see technicianRelease.js for why it is not cleared on a timer.
document.addEventListener('click', (clicked) => {
  const button = clicked.target.closest('[data-dismiss-release]');
  if (!button) return;
  dismissRelease(button.dataset.dismissRelease);
  render();
});

// The van, read separately from the board. It changes for reasons that are
// nothing to do with the job in hand — a depot run, a count taken at the start
// of the shift — so it is its own read rather than another field on
// /technician/work.
async function refreshVanStock() {
  if (!getState().token) return;
  try {
    setVanStock(await api.getVanStock());
  } catch (error) {
    // A technician with no van crewed to them gets a 409. That is a real state
    // and not an error worth a red banner across the page — the panel simply
    // has nothing to show.
    if (error.status !== 409) setError(error.message);
    setVanStock(null);
  }
  render();
}

onJobEvent(() => refreshWork());

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, {
      role: result.user.role,
      userId: result.user.id,
      email: result.user.email,
    });
    connect();
    syncOutbox();
    watchConnectivity();
    // PAINT BEFORE FETCHING. Without this the workspace stayed hidden until
    // every read had answered, so the skeleton it renders while `work.loaded`
    // is false was never on screen for a single frame — the page went from a
    // sign-in form straight to a finished board, and on a slow connection that
    // is a long blank pause with nothing to look at.
    render();
    await refreshWork();
    await refreshVanStock();
    await refreshEarnings();
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

// ONE PLACE THAT TURNS A "FITTED ONE" TAP INTO A QUEUE ITEM, called from both
// panels that offer one — the van list and the completion prompt. The queue
// mints the key, so a retry sends the same one and cannot decrement twice.
function declareOnePart(partId, jobId) {
  const job = jobId ?? getState().activeJobId ?? getState().work.jobs[0]?.jobId;
  if (!job) return;
  enqueue({ kind: 'PARTS', jobId: job, lines: [{ partId, quantity: 1 }] });
}

// The ladder, the completion code and the diagnosis form.
document.querySelector('[data-panel="ladder"]').addEventListener('click', async (clicked) => {
  // THE PARTS PROMPT on the completion step. Answering it only unlocks the code
  // input — it writes nothing, because "nothing from the van" is the absence of
  // a stock movement rather than a stock movement of zero.
  const partsAnswer = clicked.target.closest('button[data-parts-answer]');
  if (partsAnswer) {
    setCompletionParts(partsAnswer.dataset.jobId, partsAnswer.dataset.partsAnswer);
    render();
    return;
  }

  const fittedHere = clicked.target.closest('button[data-fitted]');
  if (fittedHere) {
    declareOnePart(fittedHere.dataset.fitted, fittedHere.dataset.jobId);
    return;
  }

  const stepButton = clicked.target.closest('button[data-step]');
  if (stepButton) {
    const step = stepButton.dataset.step;
    // Read the code BEFORE enqueuing: the input is inside the card, and the
    // card is rebuilt the moment the queue changes.
    const completionCode = step === 'COMPLETE' ? value('#completion-code') : undefined;
    enqueue({ jobId: stepButton.dataset.jobId, step, completionCode });
    return;
  }

  const estimateButton = clicked.target.closest('button[data-estimate]');
  if (estimateButton) {
    const jobId = estimateButton.dataset.estimate;
    if (getState().estimateInFlight === jobId) return;
    setEstimateInFlight(jobId);
    render();
    try {
      await api.raiseEstimate(jobId);
      setError(null);
    } catch (error) {
      // A job with no pinned price list answers 409 rather than failing — see
      // src/api/estimates.ts. The technician is told why in a sentence.
      setError(error.message);
    } finally {
      setEstimateInFlight(null);
    }
    await refreshWork();
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

// THE VAN. Two actions and one input, delegated because the list is rebuilt on
// every render.
document.querySelector('[data-panel="van-stock"]').addEventListener('input', (typed) => {
  const box = typed.target.closest('input[data-count]');
  if (!box) return;
  // Straight into state on every keystroke. The panel re-renders once a second
  // and would otherwise overwrite what is being typed.
  setVanCount(box.dataset.count, box.value);
});

document.querySelector('[data-panel="van-stock"]').addEventListener('click', async (clicked) => {
  const fitted = clicked.target.closest('button[data-fitted]');
  if (fitted) {
    // Enqueued, never sent straight — see declareOnePart, shared with the
    // completion step's own parts prompt.
    declareOnePart(fitted.dataset.fitted, null);
    return;
  }

  const confirm = clicked.target.closest('button[data-action="confirm-count"]');
  if (!confirm) return;
  const state = getState();
  const counted = (state.van.stock?.lines ?? []).map((line) => ({
    partId: line.partId,
    // An empty or unparseable box means "leave this one as it is", which is
    // what sending the current quantity says: the count agreed, and the shelf
    // is freshly confirmed.
    quantity: Number.parseInt(state.van.counts[line.partId] ?? String(line.quantity), 10) || 0,
  }));
  if (counted.length === 0) return;
  try {
    // Minted here, at the tap, for the same reason the queue mints its key at
    // the tap: a double press must record one count, not two.
    await api.confirmVanStock(crypto.randomUUID(), counted);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await refreshVanStock();
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
