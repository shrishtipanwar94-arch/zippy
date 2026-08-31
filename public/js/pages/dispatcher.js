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
  getState,
} from '../state.js';
import * as api from '../api.js';
import { connect } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';
import { render as renderPlans } from '../panels/plans.js';
import { render as renderTimeline } from '../panels/timeline.js';
import { render as renderInspector } from '../panels/inspector.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);
registerPanel(renderPlans);
registerPanel(renderTimeline);
registerPanel(renderInspector);

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
    await refreshTimeline();
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
