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

const STEPS = ['symptoms', 'safety', 'location'];

export function render(state) {
  const panel = document.querySelector('[data-panel="request"]');
  if (!panel) return;

  // The flow disappears once a job exists — from then on this page is about
  // one incident, not about starting another.
  panel.hidden = Boolean(state.activeJobId);
  if (panel.hidden) return;

  for (const step of STEPS) {
    const section = panel.querySelector(`[data-step="${step}"]`);
    if (section) section.hidden = state.request.step !== step;
  }

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
}

// A chosen option is shown by swapping the outline for a solid fill AND by the
// button being the only one still emphasised — colour is never the only signal
// (docs/UI.md).
function markSelected(panel, selector, attribute, chosen) {
  for (const button of panel.querySelectorAll(selector)) {
    const isChosen = button.dataset[attribute] === chosen;
    const className = isChosen
      ? 'btn btn-warning text-start'
      : `btn btn-outline-light text-start${selector === '[data-complaint]' ? ' btn-lg' : ''}`;
    if (button.className !== className) button.className = className;
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
