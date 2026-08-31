// The driver's side of intake: report a breakdown, then answer whatever the
// entropy selector asks, until it stops asking.
//
// The question count is not fixed and this panel does not know what it will be.
// A stated flat tyre gets zero questions and goes straight to "intake complete";
// a bare "will not start" gets several. That is the whole point of Phase 3 made
// visible — the panel just renders whatever the server says comes next.

export function render(state) {
  const panel = document.querySelector('[data-panel="intake-question"]');
  if (!panel) return;

  const prompt = panel.querySelector('[data-field="question-prompt"]');
  const answers = panel.querySelector('[data-field="question-answers"]');
  const done = panel.querySelector('[data-field="intake-done"]');

  const question = state.nextQuestion;

  panel.hidden = !state.activeJobId;
  // THE STOP REASON IS NOT SHOWN. `state.intakeDone` carries the stop condition
  // that ended the questions — ENTROPY_BELOW_THRESHOLD and friends — which is
  // diagnostic detail for a dispatcher and an enum on a driver's screen. The
  // browser walk-through caught it rendered as "Intake complete:
  // ENTROPY_BELOW_THRESHOLD". The code is not lost: it is in the
  // INTAKE_COMPLETED event payload, where the console's timeline shows it.
  if (done) {
    done.textContent = state.intakeDone ? 'Thank you — we have everything we need.' : '';
    done.hidden = !state.intakeDone;
  }

  if (!question) {
    if (prompt) prompt.textContent = '';
    if (answers) answers.replaceChildren();
    return;
  }

  if (prompt && prompt.textContent !== question.prompt) prompt.textContent = question.prompt;

  if (!answers) return;

  // Rebuild only when the answer set actually changed — otherwise a re-render
  // triggered by an unrelated job event would replace the buttons the driver
  // is in the middle of clicking.
  const wanted = question.answers.map((answer) => answer.value).join('|');
  if (answers.dataset.answers === wanted) return;

  answers.dataset.answers = wanted;
  answers.replaceChildren();
  for (const answer of question.answers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-light btn-lg text-start';
    // THE VALUE GOES IN A DATA ATTRIBUTE, THE LABEL ON THE BUTTON. The API
    // takes the answer code, and the driver reads words — the browser
    // walk-through found this rendering CLICKING and GRINDING before the
    // server started sending both.
    button.dataset.answer = answer.value;
    button.dataset.questionCode = question.code;
    button.textContent = answer.label;
    answers.appendChild(button);
  }
}
