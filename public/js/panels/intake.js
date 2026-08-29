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
  if (done) {
    done.textContent = state.intakeDone ? `Intake complete: ${state.intakeDone}` : '';
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
  const wanted = question.answers.join('|');
  if (answers.dataset.answers === wanted) return;

  answers.dataset.answers = wanted;
  answers.replaceChildren();
  for (const answer of question.answers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-primary me-2 mb-2';
    button.dataset.answer = answer;
    button.dataset.questionCode = question.code;
    button.textContent = answer;
    answers.appendChild(button);
  }
}
