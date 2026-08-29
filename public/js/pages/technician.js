// The technician page. The jobs assigned to this technician, and the event
// trail for whichever one is selected.
//
// It will be EMPTY until Phase 9. Row ownership narrows a technician's job
// reads to `assignedTechnicianId = their id`, and nothing assigns a technician
// yet — allocation is Phase 9 and the Phase 4 brief explicitly rules out
// building it here. The page is wired end to end so that when assignment
// arrives this surface already works; an empty list today is the correct
// output, not a broken one.

import { registerPanel, render, setActiveJob, setError, setJobs, setSession, getState } from '../state.js';
import * as api from '../api.js';
import { connect, subscribeToJob } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderJobsTable } from '../panels/jobsTable.js';
import { render as renderJobDetail } from '../panels/jobDetail.js';

registerPanel(renderSession);
registerPanel(renderJobsTable);
registerPanel(renderJobDetail);

function value(selector) {
  return document.querySelector(selector).value.trim();
}

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, { role: result.user.role, userId: result.user.id });

    const jobs = await api.listJobs();
    setJobs(jobs.jobs);
    connect();

    // A technician's jobs are theirs by assignment, so every one of them is a
    // job this page may subscribe to.
    for (const job of jobs.jobs) {
      subscribeToJob(job.id);
    }
    if (jobs.jobs.length > 0) setActiveJob(jobs.jobs[0].id);
  } catch (error) {
    setError(error.message);
  }
  render();
});

// Clicking a row selects it. Delegated, because rows are created and removed by
// the table panel as jobs come and go.
document.querySelector('[data-panel="jobs-table"]').addEventListener('click', (clicked) => {
  const row = clicked.target.closest('tr[data-job-id]');
  if (!row) return;
  if (getState().activeJobId === row.dataset.jobId) return;

  setActiveJob(row.dataset.jobId);
  subscribeToJob(row.dataset.jobId);
  render();
});

render();
