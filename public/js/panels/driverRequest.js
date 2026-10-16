// THE THREE-STEP REQUEST FLOW — symptoms, then safety, then location.
//
// Three screens rather than one form, because the person filling this in is
// stressed and possibly standing next to moving traffic. One question at a
// time is the whole design brief for this surface (docs/UI.md).
//
// The step lives in state, never in the DOM. A socket event can re-render this
// page at any moment, and a wizard whose current step is "whichever section
// does not have the hidden attribute" loses the driver's place every time that
// happens.
//
// Selections are also state, not form values read at submit time — for the
// same reason. The checkboxes are the one exception: they are read at the
// moment Continue is pressed and written into state there, because a checkbox
// keeps its own value across a re-render and mirroring six of them on every
// keystroke would be more code for no gain.

import { describeAccuracy } from '../geolocation.js';

const STEPS = ['describe', 'symptoms', 'safety', 'location'];

// The complaint buttons carry enum values in data attributes; a driver never
// reads one. This is the one place the value has to be turned back into words,
// because the confirmation sentence names what the assistant understood.
const COMPLAINT_WORDS = {
  WONT_START: 'it will not start',
  FLAT_TYRE: 'a flat tyre',
  LOCKED_OUT: 'you are locked out',
  WARNING_LIGHT: 'a warning light',
  NOISE_OR_SMELL: 'an odd noise or smell',
  STUCK_OR_DAMAGED: 'the car is stuck or damaged',
  UNKNOWN: 'you are not sure what happened',
};

// Which checkbox each urgency signal ticks. Mirrors SAFETY_FIELD_BY_SIGNAL in
// src/ai/extraction.ts; the ids are the schema's field names.
const SAFETY_CHECKBOX = {
  BLOCKING_LIVE_LANE: 'blockingLiveLane',
  SMOKE_OR_BURNING_SMELL: 'smokeOrBurningSmell',
  FUEL_SMELL: 'fuelSmell',
  OVERHEATING: 'overheating',
  DRIVER_ALONE: 'driverAlone',
  VULNERABLE_PASSENGERS: 'vulnerablePassengers',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="request"]');
  if (!panel) return;

  // The flow disappears once a job exists — from then on this page is about
  // one incident, not about starting another.
  // Hidden while a job is open, and also while the driver is being asked WHICH
  // of several open jobs they mean — offering "What has happened?" underneath
  // that question invites a second report for a breakdown already in hand.
  panel.hidden = Boolean(state.activeJobId) || (state.openJobs ?? []).length > 0;
  if (panel.hidden) return;

  for (const step of STEPS) {
    const section = panel.querySelector(`[data-step="${step}"]`);
    if (section) section.hidden = state.request.step !== step;
  }

  const describing = panel.querySelector('[data-field="describing"]');
  if (describing) describing.hidden = !state.request.describing;

  renderStepper(panel, state.request.step);
  renderAssistantNote(panel, state.request);
  prefillSafety(panel, state.request);

  markSelected(panel, '[data-complaint]', 'complaint', state.request.complaint);
  markSelected(panel, '[data-position]', 'position', state.request.location.roadPosition);

  const lat = panel.querySelector('#lat');
  const lng = panel.querySelector('#lng');
  if (lat && state.request.location.lat !== null) lat.value = String(state.request.location.lat);
  if (lng && state.request.location.lng !== null) lng.value = String(state.request.location.lng);

  const send = panel.querySelector('[data-action="report"]');
  // Nothing can be sent without a position: an unstated one triages as a risk
  // in its own right (src/domain/safety.ts), and guessing on the driver's
  // behalf is exactly what that rule exists to prevent.
  if (send) send.disabled = !state.request.location.roadPosition || state.request.locating;
  renderSendBlocked(panel, state.request);

  // WHAT THE LOCATION BUTTON DID. It used to report nothing at all: a driver
  // pressed it and the page looked identical whether the fix succeeded, failed,
  // or hung. Now it says which, and when the fix is poor it says so plainly so
  // the landmark box below stops being optional in the driver's mind.
  renderLocateStatus(state);
}

// WHY "SEND FOR HELP" IS GREY, in the driver's own words.
//
// The button is disabled until a road position is picked, and while the phone
// is still being asked where it is. Both are deliberate. Neither said so
// anywhere, and the disabled state is nearly invisible: Bootstrap dims it to
// 0.65 opacity, which on a full-strength red button against a dark page reads
// as enabled, and the cursor stays a pointer. So a driver pressed it, nothing
// happened, and nothing explained why — measured on a live page while walking
// this flow end to end. geolocation.js already learned this lesson for the
// locate button; this is the same lesson for the button that matters most.
//
// Silent when the button works: a sentence explaining an enabled control is
// noise.
function renderSendBlocked(panel, request) {
  const node = panel.querySelector('[data-field="send-blocked"]');
  if (!node) return;

  if (request.locating) {
    node.hidden = false;
    node.textContent = 'Finding where you are — this button turns on in a moment.';
    return;
  }

  if (!request.location.roadPosition) {
    node.hidden = false;
    node.textContent = 'Choose where the car is standing, above, and this button turns on.';
    return;
  }

  node.hidden = true;
  node.textContent = '';
}

// WHAT THE ASSISTANT READ, in a sentence, above the buttons that change it.
// Two states and never both: it read something, or it was unavailable.
function renderAssistantNote(panel, request) {
  const note = panel.querySelector('[data-field="ai-note"]');
  const degraded = panel.querySelector('[data-field="ai-degraded"]');

  if (degraded) {
    degraded.hidden = !request.aiDegraded;
    // The server's own sentence when it gave one (e.g. the daily cap); the
    // HTML's generic one otherwise.
    if (request.aiNotice) degraded.textContent = request.aiNotice;
  }
  if (!note) return;

  note.hidden = !request.extracted;
  if (!request.extracted) return;

  const words = COMPLAINT_WORDS[request.extracted.primaryComplaint] ?? 'something is wrong';
  note.textContent = `We understood: ${words}. If that is not right, pick the correct one below.`;
}

// The safety boxes, pre-ticked from what the driver already told us — until
// they open that step and press Continue, after which their answers are the
// only ones that count and this stops writing to the boxes.
function prefillSafety(panel, request) {
  if (request.safetyTouched || request.safetyProposed.length === 0) return;

  for (const [signal, id] of Object.entries(SAFETY_CHECKBOX)) {
    const box = panel.querySelector(`#${id}`);
    if (!box) continue;
    const shouldTick = request.safetyProposed.includes(signal);
    if (shouldTick && !box.checked) box.checked = true;
  }
}

// HOW FAR THROUGH, in filled segments and in words. Four screens with no sense
// of progress is what made this flow feel endless — someone who cannot see the
// end assumes the worst. The bar is the impression and "Step 2 of 4" is the
// fact, because a three-quarters-full bar is not information.
function renderStepper(panel, step) {
  const index = STEPS.indexOf(step);
  if (index < 0) return;

  for (const dot of panel.querySelectorAll('[data-dot]')) {
    dot.classList.toggle('is-done', Number(dot.dataset.dot) <= index);
  }

  const label = panel.querySelector('[data-field="step-label"]');
  const text = `Step ${index + 1} of ${STEPS.length}`;
  if (label && label.textContent !== text) label.textContent = text;
}

// A chosen option keeps its own shape and gains a border and a lighter ground —
// it is never colour alone (docs/UI.md), and `aria-pressed` is what carries the
// same fact to a screen reader, which cannot see either.
function markSelected(panel, selector, attribute, chosen) {
  for (const button of panel.querySelectorAll(selector)) {
    const isChosen = button.dataset[attribute] === chosen;
    button.classList.toggle('is-chosen', isChosen);
    button.setAttribute('aria-pressed', String(isChosen));
  }
}

// The safety answers, read once when the driver leaves that step. Shaped to
// match src/domain/safety.ts's report schema exactly — anything it does not
// name is not ours to send, and the schema is strict, so a stray field is a
// 400 rather than a silent strip.
export function readSafetyAnswers() {
  const checked = (id) => Boolean(document.querySelector(`#${id}`)?.checked);
  return {
    blockingLiveLane: checked('blockingLiveLane'),
    smokeOrBurningSmell: checked('smokeOrBurningSmell'),
    fuelSmell: checked('fuelSmell'),
    overheating: checked('overheating'),
    driverAlone: checked('driverAlone'),
    vulnerablePassengers: checked('vulnerablePassengers'),
  };
}


// The one line under the "use my current location" button. Three states —
// looking, found (with how good it was), and nothing yet.
function renderLocateStatus(state) {
  const node = document.querySelector('[data-field="locate-status"]');
  if (!node) return;

  const { locating, location } = state.request;

  if (locating) {
    node.hidden = false;
    node.classList.remove('is-rough');
    node.textContent = 'Finding where you are…';
    return;
  }

  if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    // Cleared as well as hidden. A hidden node holding "Finding where you are…"
    // is a sentence waiting to reappear at the wrong moment.
    node.hidden = true;
    node.textContent = '';
    return;
  }

  const accuracy = describeAccuracy(location.accuracyMetres);
  node.hidden = false;
  node.textContent = accuracy.text;
  node.classList.toggle('is-rough', accuracy.rough);
}
