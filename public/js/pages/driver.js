// The driver page. Three steps to ask for help, then one live panel.
//
// Every handler does the same three things and nothing else: call the API,
// write to state, call render(). None of them touches the DOM — reading an
// input's value is not touching it; setting one would be.
//
// THE ONE THING THIS PAGE DOES THAT OTHERS DO NOT is refetch on a socket
// event. The driver's panel is worded by the server (src/api/driver.ts), so
// an incoming JobEvent means "re-read the driver view" rather than "patch this
// object" — see state.onJobEvent for why that hook exists rather than a render
// function quietly doing I/O.

import {
  getState,
  onJobEvent,
  putJob,
  registerPanel,
  render,
  setActiveJob,
  setDriverView,
  setError,
  setNextQuestion,
  setOpenJobs,
  setRequestField,
  setSession,
  setCheckout,
  setVehicles,
} from '../state.js';
import * as api from '../api.js';
import { connect, subscribeToJob } from '../socket.js';
import { render as renderSession } from '../panels/session.js';
import { render as renderRequest, readSafetyAnswers } from '../panels/driverRequest.js';
import { render as renderIntake } from '../panels/intake.js';
import { render as renderResume } from '../panels/driverResume.js';
import { render as renderStatus } from '../panels/driverStatus.js';
import { render as renderCheckout, loadCheckout, openCheckout } from '../panels/checkout.js';
import { loadChat, registerChatPanels, wireChatActions } from '../chatActions.js';

registerPanel(renderSession);
registerPanel(renderRequest);
registerPanel(renderIntake);
registerPanel(renderResume);
registerPanel(renderStatus);
registerPanel(renderCheckout);
registerChatPanels();
wireChatActions();

function value(selector) {
  return document.querySelector(selector).value.trim();
}

async function refreshDriverView() {
  const jobId = getState().activeJobId;
  if (!jobId) return;
  try {
    setDriverView(await api.getDriverView(jobId));
    setError(null);
  } catch (error) {
    setError(error.message);
  }
  // ASKED SEPARATELY AND FAILING SEPARATELY. A gateway that is down must not
  // blank the panel telling a driver where their technician is — so this call
  // gets its own try, and a failure just leaves the pay button hidden.
  try {
    setCheckout(await loadCheckout(jobId));
  } catch (error) {
    setCheckout(null);
    console.warn('checkout unavailable', error);
  }
  render();
}

document.querySelector('[data-action="pay-callout"]')?.addEventListener('click', async () => {
  const jobId = getState().activeJobId;
  if (!jobId) return;
  try {
    await openCheckout(jobId, refreshDriverView);
  } catch (error) {
    setError(error.message);
    render();
  }
});

onJobEvent((jobId) => {
  if (jobId === getState().activeJobId) refreshDriverView();
});

document.querySelector('[data-action="login"]').addEventListener('click', async () => {
  try {
    const result = await api.login(value('#email'), value('#password'));
    setSession(result.accessToken, {
      role: result.user.role,
      userId: result.user.id,
      email: result.user.email,
    });
    connect();
    await loadVehicles();
    await restoreOpenJob();
  } catch (error) {
    setError(error.message);
  }
  render();
});

// COMING BACK TO A JOB ALREADY IN PROGRESS.
//
// The active job used to live only in memory, set at the moment this page
// created one. Locking the phone, losing the tab, or a browser reclaiming
// memory in the background therefore dropped a driver with a technician
// already on the way back onto "What has happened?" — and the natural thing to
// do from there is report the breakdown a second time.
//
// Its own try/catch, like the vehicle picker above: if this call fails the
// driver still lands on a working intake flow, which is worse than restoring
// but far better than a page that will not load.
async function restoreOpenJob() {
  try {
    const { jobs } = await api.getOpenJobs();
    if (jobs.length === 0) return;

    // One open job is the overwhelmingly common case and needs no question
    // asked — go straight back to it.
    if (jobs.length === 1) {
      setActiveJob(jobs[0].jobId);
      await refreshDriverView();
      return;
    }

    // More than one, so the driver chooses. A fleet driver with two cars off
    // the road is rare but real, and guessing for them would be worse than
    // asking.
    setOpenJobs(jobs);
  } catch (error) {
    console.warn('could not restore an open job', error);
  }
}

// Choosing from that list. Delegated, because the buttons are rendered by a
// panel and do not exist when this handler is attached.
document.querySelector('[data-panel="resume"]').addEventListener('click', async (clicked) => {
  const button = clicked.target.closest('[data-resume-job]');
  if (!button) return;
  setActiveJob(button.dataset.resumeJob);
  setOpenJobs([]);
  await refreshDriverView();
  render();
});

// "Actually, a different car has broken down." The list is not a trap.
document.querySelector('[data-action="new-report"]').addEventListener('click', () => {
  setOpenJobs([]);
  render();
});

// THE PICKER, FILLED ONCE AT SIGN-IN. A driver picks the car that has broken
// down from their own number plates; the database id lives in the option's
// value and is never shown. Its own try/catch: a vehicle list that fails to
// load must not stop somebody signing in and asking for help, so the select is
// simply left with its fallback option.
async function loadVehicles() {
  try {
    const { vehicles } = await api.listVehicles();
    setVehicles(vehicles);
    fillVehiclePicker(vehicles);
  } catch (error) {
    console.warn('could not load vehicles', error);
  }
}

function fillVehiclePicker(vehicles) {
  const picker = document.querySelector('#vehicleId');
  if (!picker) return;

  if (vehicles.length === 0) {
    picker.innerHTML = '<option value="">No vehicle registered to you</option>';
    return;
  }

  // Built with createElement rather than an HTML string: a registration is
  // user-supplied text and this is the one place on the page that would
  // otherwise interpolate it into markup.
  picker.replaceChildren(
    ...vehicles.map((vehicle) => {
      const option = document.createElement('option');
      option.value = vehicle.id;
      option.textContent = vehicle.description
        ? `${vehicle.registration} · ${vehicle.description}`
        : vehicle.registration;
      return option;
    }),
  );
}

// --- step 0: say it in your own words (Phase 16) ------------------------------
//
// Two buttons and one rule between them: NOTHING here can stop the driver
// getting to the picker. A failed call, an unavailable model, a driver who
// would rather tap — all three land on the same next screen, one with a banner
// saying why.

document.querySelector('[data-action="skip-describe"]').addEventListener('click', () => {
  setRequestField({ step: 'symptoms' });
  render();
});

document.querySelector('[data-action="describe"]').addEventListener('click', async () => {
  const text = value('#describeText');
  if (!text) {
    setRequestField({ step: 'symptoms' });
    render();
    return;
  }

  setRequestField({ describing: true });
  render();

  try {
    const read = await api.describeSymptoms(text);
    if (read.degraded) {
      setRequestField({ describing: false, aiDegraded: true, step: 'symptoms', rawText: text });
    } else {
      setRequestField({
        describing: false,
        aiDegraded: false,
        step: 'symptoms',
        rawText: text,
        extractionId: read.extractionId,
        extracted: read.symptoms,
        aiEvidence: read.evidence,
        // The complaint is PRE-SELECTED, not applied: the driver is looking at
        // the same seven buttons and one of them is already lit. Correcting it
        // is one tap on another button.
        complaint: read.symptoms.primaryComplaint,
        safetyProposed: read.hypothesis?.urgencySignals ?? [],
      });
    }
    setError(null);
  } catch (error) {
    // A failed call is a degraded assistant, not a failed request for help.
    setRequestField({ describing: false, aiDegraded: true, step: 'symptoms', rawText: text });
    setError(null);
    console.warn('describe failed', error);
  }
  render();
});

// --- step 1: what happened ---------------------------------------------------

document.querySelector('[data-field="complaints"]').addEventListener('click', (clicked) => {
  const button = clicked.target.closest('button[data-complaint]');
  if (!button) return;
  setRequestField({ complaint: button.dataset.complaint, step: 'safety' });
  render();
});

// --- step 2: are you safe ----------------------------------------------------

document.querySelector('[data-action="to-location"]').addEventListener('click', () => {
  // `safetyTouched` freezes the pre-ticking: from here the boxes are the
  // driver's answers, and a re-render must not put back one they cleared.
  setRequestField({ safety: readSafetyAnswers(), safetyTouched: true, step: 'location' });
  render();
});

// --- step 3: where are you ---------------------------------------------------

document.querySelector('[data-field="positions"]').addEventListener('click', (clicked) => {
  const button = clicked.target.closest('button[data-position]');
  if (!button) return;
  const location = { ...getState().request.location, roadPosition: button.dataset.position };
  setRequestField({ location });
  render();
});

document.querySelector('[data-action="locate"]').addEventListener('click', () => {
  if (!navigator.geolocation) {
    setError('This browser cannot share your location. Please type it in.');
    render();
    return;
  }
  setRequestField({ locating: true });
  render();

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        ...getState().request.location,
        lat: Number(position.coords.latitude.toFixed(5)),
        lng: Number(position.coords.longitude.toFixed(5)),
      };
      setRequestField({ location, locating: false });
      setError(null);
      render();
    },
    () => {
      // A refused or failed lookup is not an error worth alarming anybody
      // with — the typed coordinates are still there and still work.
      setRequestField({ locating: false });
      render();
    },
  );
});

// Both Back buttons, one listener. The step order lives in one array so there
// is one definition of what "back" means.
const STEP_ORDER = ['describe', 'symptoms', 'safety', 'location'];
for (const button of document.querySelectorAll('[data-action="back"]')) {
  button.addEventListener('click', () => {
    const index = STEP_ORDER.indexOf(getState().request.step);
    setRequestField({ step: STEP_ORDER[Math.max(0, index - 1)] });
    render();
  });
}

document.querySelector('[data-action="report"]').addEventListener('click', async () => {
  const request = getState().request;
  try {
    // No `onHighway` anywhere. The server derives it from the road position
    // and uses that one value for both the stored column and the safety
    // triage, so there is nothing here that could contradict it — and the
    // schemas are strict, so trying to send it would be a 400 rather than a
    // silently ignored field.
    const created = await api.createIntake({
      vehicleId: value('#vehicleId'),
      // WHAT THE DRIVER IS SUBMITTING, which is the extracted form with their
      // own complaint on top — the button they left lit, or the one they
      // corrected it to. When they never described anything, `extracted` is
      // null and this is exactly the Phase 3 payload.
      symptoms: {
        ...(request.extracted ?? {}),
        primaryComplaint: request.complaint ?? 'UNKNOWN',
      },
      extractionId: request.extractionId ?? undefined,
      rawText: request.rawText ?? undefined,
      location: {
        lat: Number(value('#lat')),
        lng: Number(value('#lng')),
        roadPosition: request.location.roadPosition,
        landmark: value('#landmark') || null,
      },
      safety: request.safety,
    });

    putJob({ id: created.jobId, status: 'INTAKE', safetyLevel: created.safetyLevel });
    setActiveJob(created.jobId);
    setNextQuestion(created.next);
    setRequestField({ step: 'sent' });
    subscribeToJob(created.jobId);
    setError(null);
    await refreshDriverView();
    await loadChat(created.jobId);
  } catch (error) {
    setError(error.message);
  }
  render();
});

// THE DRIVER'S ANSWER TO AN ESTIMATE. Three buttons, one handler, because they
// differ only in the word they send — and the server decides what each means.
const ESTIMATE_DECISIONS = {
  'approve-estimate': 'APPROVE',
  'decline-estimate': 'DECLINE',
  'cancel-estimate': 'CANCEL',
};

for (const [action, decision] of Object.entries(ESTIMATE_DECISIONS)) {
  document.querySelector(`[data-action="${action}"]`).addEventListener('click', async () => {
    const estimate = getState().driverView?.estimate;
    if (!estimate) return;
    try {
      await api.respondToEstimate(estimate.estimateId, decision);
      setError(null);
    } catch (error) {
      setError(error.message);
    }
    // The answer changed the job, so re-read the panel the server words.
    await refreshDriverView();
  });
}

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
  await refreshDriverView();
});

render();
