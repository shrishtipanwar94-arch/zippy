// The driver page. Report a breakdown, answer the questions intake asks, watch
// the event trail for that one job.
//
// Every handler here does the same three things and nothing else: call the API,
// write to state, call render(). None of them touches the DOM — reading an
// input's value is not touching it; setting one would be.

import { getState, registerPanel, render, setActiveJob, setError, setNextQuestion, setSession, putJob } from '../state.js';
import * as api from '../api.js';
import { connect, subscribeToJob } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderIntake } from '../panels/intake.js';
import { render as renderJobDetail } from '../panels/jobDetail.js';

registerPanel(renderSession);
registerPanel(renderIntake);
registerPanel(renderJobDetail);

function value(selector) {
  return document.querySelector(selector).value.trim();
}

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, { role: result.user.role, userId: result.user.id });
    connect();
  } catch (error) {
    setError(error.message);
  }
  render();
});

document.querySelector('[data-action="report"]').addEventListener('click', async () => {
  try {
    // `onHighway` is sent TWICE, and that is a workaround, not a design.
    // The field exists on both the location schema (a routing fact: which
    // carriageway, what a unit has to do to reach it) and the safety context
    // (a risk fact: traffic passing at speed), and POST /jobs/intake does not
    // connect them. A client that fills in only the location one gets NORMAL
    // safety for a highway breakdown. The real fix is for the route to derive
    // the safety flag from the location, which is server work this page is not
    // allowed to do; until then every client has to know to send both.
    const onHighway = document.querySelector('#onHighway').checked;

    const created = await api.createIntake({
      vehicleId: value('#vehicleId'),
      symptoms: { primaryComplaint: value('#complaint') },
      location: {
        lat: Number(value('#lat')),
        lng: Number(value('#lng')),
        roadPosition: value('#roadPosition'),
        onHighway,
      },
      safety: {
        onHighway,
        driverAlone: document.querySelector('#driverAlone').checked,
      },
    });

    putJob({ id: created.jobId, status: 'INTAKE', safetyLevel: created.safetyLevel });
    setActiveJob(created.jobId);
    setNextQuestion(created.next);
    subscribeToJob(created.jobId);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

// One delegated listener rather than one per button: the answer buttons are
// replaced whenever the question changes, and a listener bound to a removed
// element is a leak and a bug waiting to happen.
document.querySelector('[data-field="question-answers"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('button[data-answer]');
  if (!button) return;

  const jobId = getState().activeJobId;
  try {
    const result = await api.answerQuestion(jobId, button.dataset.questionCode, button.dataset.answer);
    setNextQuestion(result.next);
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  render();
});

render();
