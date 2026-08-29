// The dispatch board. Every job in the system, patched row by row as events
// arrive.
//
// A dispatcher joins every zone room at connect and therefore receives events
// for jobs it never subscribed to — that is the zone fan-out doing its job, and
// it is why this page needs no per-job subscription to stay current.

import { getState, putJob, registerPanel, render, setError, setJobs, setSession, setUnits } from '../state.js';
import * as api from '../api.js';
import { connect } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);

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
    const [jobs, units] = await Promise.all([api.listJobs(), api.listUnits()]);
    setJobs(jobs.jobs);
    setUnits(units.units);
    connect();
  } catch (error) {
    setError(error.message);
  }
  render();
});

// Delegated, because rows are created and removed by the table panel as jobs
// arrive. Binding per row would leak listeners on every removal.
document.querySelector('[data-panel="jobs-table"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('button[data-action="assign"]');
  if (!button) return;

  const row = button.closest('tr[data-job-id]');
  const unitId = row.querySelector('[data-field="unit-select"]').value;
  if (!unitId) return;

  try {
    const result = await api.assignUnit(row.dataset.jobId, unitId);
    // The socket will carry the UNIT_ASSIGNED event to every other window; this
    // updates the window that clicked, without waiting for the round trip back.
    putJob({
      id: result.jobId,
      status: 'PLANNED',
      assignedUnitId: result.unitId,
      assignedTechnicianId: result.technicianId,
    });

    // The unit is now ON_JOB and must leave every dropdown — invariant 7, one
    // active job per unit. Refetched rather than patched locally, because
    // another dispatcher may have taken units too.
    const units = await api.listUnits();
    setUnits(units.units);
    setError(null);
  } catch (error) {
    // lost_race and unit_not_available are normal outcomes here, not faults:
    // someone else took the unit between the page loading and the click.
    setError(error.message);
    const units = await api.listUnits().catch(() => ({ units: getState().units }));
    setUnits(units.units);
  }
  render();
});

render();