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
  setTimeline,
  setTimelineFilter,
  setInspectorJob,
  setInspectorDecision,
  setScarcity,
  setQueue,
  setPlanSelection,
  setOverrideReasonDraft,
  getState,
} from '../state.js';
import * as api from '../api.js';
import { connect } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';
import { render as renderPlans } from '../panels/plans.js';
import { render as renderTimeline } from '../panels/timeline.js';
import { render as renderInspector } from '../panels/inspector.js';
import { render as renderScarcity } from '../panels/scarcity.js';
import { render as renderQueue } from '../panels/queue.js';
import { renderSelectionError } from '../panels/plans.js';
import { render as renderMap } from '../panels/map.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);
registerPanel(renderPlans);
registerPanel(renderTimeline);
registerPanel(renderInspector);
registerPanel(renderScarcity);
registerPanel(renderQueue);
registerPanel(renderSelectionError);
registerPanel(renderMap);

function value(selector) {
  return document.querySelector(selector).value.trim();
}

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, { role: result.user.role, userId: result.user.id });

    // The socket carries changes, not the starting picture. The board is
    // seeded once over HTTP and kept current over the socket from then on —
    // polling is the Phase 17 fallback, not the mechanism.
    const jobs = await api.listJobs();
    setJobs(jobs.jobs);
    await Promise.all([refreshTimeline(), refreshBoard()]);
    connect();
  } catch (error) {
    setError(error.message);
  }
  render();
});

// SOLVE — what replaced the per-row unit dropdown. One button for the whole
// board: the solver plans every pending job at once, because a global
// assignment is the entire point of Phase 9. Picking units one at a time is
// exactly the greedy behaviour that strands jobs.
document.querySelector('[data-action="solve"]').addEventListener('click', async () => {
  try {
    setSolve(await api.solveJobs());
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

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
    const [scarcity, queue] = await Promise.all([api.getScarcity(), api.getQueue()]);
    setScarcity(scarcity);
    setQueue(queue);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
}

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
  render();
}

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
