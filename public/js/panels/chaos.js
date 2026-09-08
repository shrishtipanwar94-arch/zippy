// THE BREAK-IT PANEL. Four switches that stay on, four buttons that happen
// once, and one reset.
//
// IT DISAPPEARS WHEN THE SERVER DOES NOT OFFER IT. `GET /chaos` is not mounted
// in a production build, so the page asks once, gets a 404, and never renders
// the panel. There is no build flag in the browser to get wrong — the server's
// answer is the flag.
//
// RESET IS THE MOST IMPORTANT BUTTON HERE. A demo that leaves the system in a
// broken state it cannot be talked out of is the worst possible outcome, so
// there is one control that always puts everything back.

const SWITCH_LABELS = {
  LLM_DOWN: 'Symptom assistant',
  REDIS_DOWN: 'Redis (queues and fan-out)',
  WEBSOCKET_DOWN: 'Live updates',
  SOLVER_TIMEOUT: 'Force planner timeout',
};

const ACTION_LABELS = {
  TECHNICIAN_OFFLINE: 'Take a technician offline',
  BREAK_UNIT: 'Break a unit',
  DECLINE_DESTINATION: 'Force a destination decline',
  INJECT_JOBS: 'Inject 5 jobs',
  // Not a clock: it ages the board by ten minutes, which every deadline in the
  // system reads the same way. See src/chaos/actions.ts.
  ADVANCE_TIME: 'Advance the board 10 minutes',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="chaos"]');
  if (!panel) return;

  panel.hidden = !state.chaos.available;
  if (panel.hidden) return;

  const switches = panel.querySelector('[data-field="chaos-switches"]');
  if (switches) {
    switches.replaceChildren(...state.chaos.switches.map(renderSwitch));
  }

  const note = panel.querySelector('[data-field="chaos-note"]');
  if (note) note.textContent = state.chaos.note ?? '';
}

function renderSwitch(row) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-check form-switch';

  const input = document.createElement('input');
  input.className = 'form-check-input';
  input.type = 'checkbox';
  input.id = `chaos-${row.name}`;
  input.checked = row.enabled;
  input.dataset.chaosSwitch = row.name;

  const label = document.createElement('label');
  label.className = 'form-check-label';
  label.htmlFor = input.id;
  label.textContent = SWITCH_LABELS[row.name] ?? row.name;

  wrapper.append(input, label);
  return wrapper;
}

export { ACTION_LABELS };
