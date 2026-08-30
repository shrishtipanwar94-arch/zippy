// The dispatch board. Every job in the system, patched row by row as events
// arrive.
//
// A dispatcher joins every zone room at connect and therefore receives events
// for jobs it never subscribed to — that is the zone fan-out doing its job, and
// it is why this page needs no per-job subscription to stay current.

import { registerPanel, render, setError, setJobs, setSession, setSolve } from '../state.js';
import * as api from '../api.js';
import { connect } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';
import { render as renderPlans } from '../panels/plans.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);
registerPanel(renderPlans);

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