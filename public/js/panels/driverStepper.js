// WHAT STAGE THIS IS AT, for the driver.
//
// The technician has had a segmented rung bar since Phase 22b. The driver had
// nothing: the headline said what was happening right now and gave them no way
// to tell whether "we are finding someone" was the second step of five or the
// fourth. For somebody waiting, that difference is most of what they want to
// know, and its absence is why the wait felt open-ended.
//
// THIS PANEL OWNS NO WORDS. The five stages, their labels and which one is
// current all arrive already decided from src/domain/driverNarrative.ts —
// `stagesFor`. That is the same rule the headline follows and it exists for the
// same reason: "no enum reaches a driver" is only enforceable if there is one
// place a status becomes English, and it is on the server where a test can scan
// it.
//
// Vertical, because the labels are short sentences and five of them do not fit
// across a 390px phone.

const STATE_CLASS = {
  done: 'is-done',
  current: 'is-current',
  todo: '',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="driver-stepper"]');
  if (!panel) return;

  const stages = state.driverView?.stages ?? [];
  // An empty list means the server did not recognise the status. No stepper at
  // all beats a stepper with nothing highlighted.
  panel.hidden = stages.length === 0;
  if (panel.hidden) return;

  const list = panel.querySelector('[data-field="stepper-list"]');
  if (!list) return;

  list.replaceChildren(
    ...stages.map((stage) => {
      const row = document.createElement('li');
      row.className = STATE_CLASS[stage.state] ?? '';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.textContent = stage.label;

      // So a screen reader lands on the current stage rather than making
      // somebody infer position from five equal-sounding list items.
      if (stage.state === 'current') row.setAttribute('aria-current', 'step');

      row.append(dot, label);
      return row;
    }),
  );
}
