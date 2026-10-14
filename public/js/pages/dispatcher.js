// The dispatch board. Every job in the system, patched row by row as events
// arrive.
//
// A dispatcher joins every zone room at connect and therefore receives events
// for jobs it never subscribed to — that is the zone fan-out doing its job, and
// it is why this page needs no per-job subscription to stay current.

import {
  registerPanel,
  render,
  setError,
  setJobs,
  setSession,
  setSolve,
  startSolveTrace,
  pushSolveStage,
  finishSolveTrace,
  setTimeline,
  setTimelineFilter,
  setInspectorJob,
  setInspectorDecision,
  setScarcity,
  setQueue,
  setPlanSelection,
  setOverrideReasonDraft,
  setHealth,
  setStuckPayments,
  setChaos,
  setEscalation,
  setEscalationDecision,
  setActions,
  getState,
} from '../state.js';
import * as api from '../api.js';
import { connect, onPoll } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';
import { render as renderPlans } from '../panels/plans.js';
import { render as renderSolveTrace } from '../panels/solveTrace.js';
import { render as renderTimeline } from '../panels/timeline.js';
import { render as renderInspector } from '../panels/inspector.js';
import { render as renderScarcity } from '../panels/scarcity.js';
import { render as renderQueue } from '../panels/queue.js';
import { renderSelectionError } from '../panels/plans.js';
import { render as renderMap } from '../panels/map.js';
import { render as renderHealth } from '../panels/health.js';
import { render as renderChaos } from '../panels/chaos.js';
import { render as renderEscalation } from '../panels/escalation.js';
import { render as renderActions } from '../panels/actions.js';
import { render as renderStats } from '../panels/stats.js';
// THE CONFIRMATION CARDS (Phase 15b), on the console for the first time in
// Phase 22b. The technician's page is the reference implementation — the same
// two calls, the same shared handlers — because a dispatcher confirming a
// location correction and a technician confirming one are the same act against
// the same route.
import { loadPromotions, registerChatPanels, wireChatActions } from '../chatActions.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);
registerPanel(renderSolveTrace);
registerPanel(renderPlans);
registerPanel(renderTimeline);
registerPanel(renderInspector);
registerPanel(renderScarcity);
registerPanel(renderQueue);
registerPanel(renderSelectionError);
registerPanel(renderMap);
registerPanel(renderHealth);
registerPanel(renderChaos);
registerPanel(renderEscalation);
registerPanel(renderActions);
registerPanel(renderStats);
registerChatPanels();
// Wires the confirm/dismiss delegation. The message, photo and location
// handlers it also offers find no controls on this page and bind nothing.
wireChatActions();

function value(selector) {
  return document.querySelector(selector).value.trim();
}

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, {
      role: result.user.role,
      userId: result.user.id,
      email: result.user.email,
    });

    // The socket carries changes, not the starting picture. The board is
    // seeded once over HTTP and kept current over the socket from then on —
    // polling is the Phase 17 fallback, not the mechanism.
    const jobs = await api.listJobs();
    setJobs(jobs.jobs);
    await Promise.all([refreshTimeline(), refreshBoard(), refreshHealth(), loadChaosPanel()]);
    connect();
    startHealthPolling();
  } catch (error) {
    setError(error.message);
  }
  render();
});

// SOLVE — what replaced the per-row unit dropdown. One button for the whole
// board: the solver plans every pending job at once, because a global
// assignment is the entire point of Phase 9. Picking units one at a time is
// exactly the greedy behaviour that strands jobs.
//
// AND IT NARRATES ITSELF ON THE WAY. The route streams a line per stage while
// the run is happening (src/api/solve.ts), so the screen fills in with what the
// solver is doing instead of pausing and producing a report.
let solving = false;

document.querySelector('[data-action="solve"]').addEventListener('click', async () => {
  // Two runs at once would interleave their stages into one transcript that
  // describes neither of them.
  if (solving) return;
  solving = true;

  startSolveTrace();
  // The previous run's plans go with the previous run's transcript. Leaving
  // them under a trace describing a different board is the one thing this panel
  // must not do.
  setSolve(null);
  render();

  try {
    const result = await api.solveJobs(showStage);
    // The last stages land a millisecond apart; this lets them finish arriving
    // before the plans appear underneath them.
    await traceQueue;
    setSolve(result);
    setError(null);
  } catch (error) {
    setError(error.message);
  }

  finishSolveTrace();
  solving = false;
  render();
});

// A MINIMUM BEAT BETWEEN LINES, and nothing more than that.
//
// The first stages land while the routing calls are still going, so they
// genuinely arrive seconds apart. The last four are arithmetic over data already
// in memory and land within a millisecond of each other, which would drop four
// sentences on the screen at once and read as a result rather than as work. The
// beat delays SHOWING a line that has already arrived; it never invents one and
// never reorders them.
const TRACE_LINE_MS = 110;
let traceQueue = Promise.resolve();

function showStage(stage) {
  traceQueue = traceQueue.then(async () => {
    pushSolveStage(stage);
    render();
    await new Promise((resolve) => setTimeout(resolve, TRACE_LINE_MS));
  });
}

render();

// ---------------------------------------------------------------------------
// THE CONSOLE'S TWO PANELS.

async function refreshTimeline() {
  try {
    setTimeline(await api.listEvents(getState().timeline.filters));
    setError(null);
  } catch (error) {
    setError(error.message);
  }
}

// Delegated, because the filter controls and every timeline row live inside a
// panel that re-renders. Binding per row would leak a listener on every event.
document.querySelector('[data-panel="timeline"]').addEventListener('change', async (changed) => {
  const control = changed.target.closest('[data-filter]');
  if (!control) return;
  setTimelineFilter(control.dataset.filter, control.value.trim());
  await refreshTimeline();
  render();
});

document.querySelector('[data-panel="timeline"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-action="inspect"]');
  if (!button) return;

  setInspectorJob(button.dataset.jobId);
  render(); // paint the selection immediately; the decision arrives after

  try {
    setInspectorDecision(await api.getDecision(button.dataset.jobId));
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

document.querySelector('[data-action="refresh-timeline"]').addEventListener('click', async () => {
  await refreshTimeline();
  render();
});

// Scarcity and the queue are whole-board reads rather than per-event ones: a
// single job event rarely changes either, and refetching both on every arrival
// would be a request per event on a board taking one every few seconds.
async function refreshBoard() {
  try {
    // The action queue rides along with the board read. It changes for the same
    // reasons the queue does — a re-plan trigger, an SLA window closing — and a
    // third round trip on the same button would buy nothing.
    const [scarcity, queue, actions] = await Promise.all([
      api.getScarcity(),
      api.getQueue(),
      api.listActions(),
    ]);
    setScarcity(scarcity);
    setQueue(queue);
    setActions(actions.actions);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
}

// THE TWO TIERS ARE TWO DIFFERENT ACTS, so they are two different handlers
// rather than one with a flag. Executing a recommendation is doing the work the
// system proposed; signing off an APPROVE is accepting responsibility for a
// call the system explicitly refused to make, and that signature is recorded.
document.querySelector('[data-panel="actions"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-execute], [data-approve], [data-reject]');
  if (!button) return;

  try {
    if (button.dataset.execute) {
      await api.executeAction(button.dataset.execute);
    } else if (button.dataset.approve) {
      await api.approveAction(button.dataset.approve, 'APPROVED');
    } else {
      await api.approveAction(button.dataset.reject, 'REJECTED');
    }
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await refreshBoard();
  render();
});

document.querySelector('[data-action="refresh-board"]').addEventListener('click', async () => {
  await refreshBoard();
  render();
});

// The inspect button appears in two panels now — the timeline and the queue —
// so the handler is bound once on a common ancestor rather than per panel.
document.querySelector('[data-panel="queue"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-action="inspect"]');
  if (!button) return;
  await inspect(button.dataset.jobId);
});

async function inspect(jobId) {
  setInspectorJob(jobId);
  render(); // paint the selection immediately; the decision arrives after
  try {
    setInspectorDecision(await api.getDecision(jobId));
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  await loadEscalation(jobId);
  // Flagged messages on the job being inspected. Cards for OTHER jobs in the
  // dispatcher's zones still arrive over the socket and stay on screen — each
  // one names its job, which is why the console's panel asks for that and the
  // field surfaces do not.
  await loadPromotions(jobId);
  render();
}

// A job with a plan has a decision record and no card; a job without one has
// no decision to show, which is precisely when the dispatcher needs to be
// told why and what they can do about it.
async function loadEscalation(jobId) {
  try {
    const response = await api.getEscalation(jobId);
    // A job with at least one FEASIBLE option had a plan available, whether or
    // not anybody committed to it — that is not an escalation. The card is for
    // the job where every option was refused.
    const feasible = getState().inspector.decision?.chosen ?? [];
    setEscalation(feasible.length > 0 ? null : { ...response.card, jobId });
  } catch {
    setEscalation(null);
  }
}

// ---------------------------------------------------------------------------
// THE DEGRADATION LADDER (Phase 17).
//
// POLLED, NOT PUSHED, and deliberately: the banner has to be able to tell the
// operator that the push channel is down, which it cannot do over the push
// channel. Fifteen seconds matches the server's health loop, so the console is
// never more than two ticks behind the truth.

const HEALTH_POLL_MS = 15000;
let healthTimer = null;

async function refreshHealth() {
  try {
    setHealth(await api.getHealth());
  } catch {
    // A failed health read is itself information, but not the kind worth an
    // error banner over the top of the degradation banner. The next tick tries
    // again.
  }
}

// THE DRILL-THROUGH BEHIND THE BANNER'S PAYMENTS LINE. Toggles: a second press
// clears the list rather than refetching it, so the button is its own Hide.
document.querySelector('[data-panel="health"]').addEventListener('click', async (clicked) => {
  if (!clicked.target.closest('[data-action="show-stuck-payments"]')) return;

  if (getState().stuckPayments) {
    setStuckPayments(null);
    render();
    return;
  }

  try {
    const result = await api.getStuckPayments();
    setStuckPayments(result.payments);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

function startHealthPolling() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    await refreshHealth();
    render();
  }, HEALTH_POLL_MS);
}

// THE POLLING FALLBACK'S CALLBACK. Registered here rather than in socket.js
// because what is worth refetching is a property of this page: the board, the
// timeline and the ladder.
onPoll(async () => {
  await Promise.all([refreshTimeline(), refreshBoard(), refreshHealth()]);
  render();
});

// ---------------------------------------------------------------------------
// THE CHAOS PANEL. Absent unless the server offers it.

async function loadChaosPanel() {
  try {
    const chaos = await api.getChaos();
    setChaos({ available: true, switches: chaos.switches, note: null });
  } catch {
    // A 404 is the expected answer in a production build. Not an error.
    setChaos({ available: false, switches: [] });
  }
}

const chaosPanel = document.querySelector('[data-panel="chaos"]');

chaosPanel.addEventListener('change', async (changed) => {
  const input = changed.target.closest('[data-chaos-switch]');
  if (!input) return;
  try {
    const result = await api.setChaosSwitch(input.dataset.chaosSwitch, input.checked);
    setHealth(result.health);
    setChaos({ note: `${input.dataset.chaosSwitch} ${input.checked ? 'on' : 'off'}` });
    await loadChaosPanel();
  } catch (error) {
    setError(error.message);
  }
  render();
});

chaosPanel.addEventListener('click', async (clicked) => {
  const action = clicked.target.closest('[data-chaos-action]');
  const reset = clicked.target.closest('[data-action="chaos-reset"]');
  if (!action && !reset) return;

  try {
    if (reset) {
      const result = await api.resetChaos();
      setHealth(result.health);
      setChaos({ note: 'everything reset' });
    } else {
      const result = await api.runChaosAction(action.dataset.chaosAction, { count: 5 });
      setChaos({ note: result.detail });
    }
    await Promise.all([loadChaosPanel(), refreshBoard()]);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

// ---------------------------------------------------------------------------
// THE ESCALATION CARD. Fetched alongside the decision record: a job with no
// plan has no decision to show, and that is exactly when this card matters.

const escalationPanel = document.querySelector('[data-panel="escalation"]');

escalationPanel.addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-escalation]');
  if (!button) return;

  const jobId = getState().escalation?.jobId;
  if (!jobId) return;

  try {
    await api.decideEscalation(jobId, button.dataset.escalation, null);
    setEscalationDecision(`Recorded: ${button.textContent.trim()}.`);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

// ---------------------------------------------------------------------------
// SELECTING A PLAN.

const plansPanel = document.querySelector('[data-panel="plans"]');

// Typing is captured into state on every keystroke, because the panel rebuilds
// wholesale and an input's value would otherwise be discarded by any render
// that happened mid-sentence.
plansPanel.addEventListener('input', (typed) => {
  const field = typed.target.closest('[data-field="override-reason"]');
  if (!field) return;
  setOverrideReasonDraft(field.dataset.plan, field.value);
});

plansPanel.addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-action="select-plan"]');
  if (!button) return;

  const label = button.dataset.plan;
  const reason = getState().planSelection.reasonDraft[label] ?? '';

  try {
    const result = await api.selectPlan(button.dataset.planVariantId, reason.trim() || undefined);
    setPlanSelection({
      planVariantId: result.planVariantId,
      label: result.label,
      isOverride: result.isOverride,
      error: null,
    });
    setError(null);
  } catch (error) {
    // The server refuses an override with no reason (422). Surfaced next to
    // the plans rather than in the page-level error strip, because it is a
    // correction to the thing the operator is doing rather than a failure.
    setPlanSelection({ error: error.message });
  }
  render();
});
