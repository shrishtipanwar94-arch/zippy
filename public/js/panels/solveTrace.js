// THE SOLVE, NARRATING ITSELF — the stage lines, as they land.
//
// Press Solve and this fills in one line at a time instead of the screen
// pausing and a report appearing. What is on it is the architecture, in
// sentences: how many jobs were waiting, how many crew-and-job combinations
// existed, how many survived the hard filters and what refused the rest, that
// the dangerous jobs were matched in a round of their own before cost was
// compared at all, how many jobs ended up with a crew, and how long it took.
//
// APPENDS, NEVER REBUILDS. Lines only ever arrive at the end, so a line already
// on screen is never touched again — which is what makes the panel read like
// work happening rather than a list that keeps flickering. The one exception is
// a new solve, which empties the list first (see `startSolveTrace` in state.js).
//
// The wording is not here. Every sentence comes from solveNarration.js, which
// is pure and asserted by tests/narration.test.ts; this file decides only where
// the words go.

import { stageSentence } from './solveNarration.js';

export function render(state) {
  const panel = document.querySelector('[data-panel="solve-trace"]');
  if (!panel) return;

  const trace = state.solveTrace;
  panel.hidden = trace.stages.length === 0;

  // The list is keyed by how many lines are already on it, so a render caused
  // by an unrelated socket event redraws nothing.
  const already = panel.querySelectorAll('[data-trace-line]').length;
  if (already > trace.stages.length) {
    // A new solve emptied the list. Nothing to keep.
    panel.replaceChildren();
    appendFrom(panel, trace, 0);
  } else {
    appendFrom(panel, trace, already);
  }

  panel.classList.toggle('solve-trace-running', trace.running);
}

function appendFrom(panel, trace, from) {
  for (let index = from; index < trace.stages.length; index += 1) {
    const sentence = stageSentence(trace.stages[index]);
    if (sentence) panel.append(lineElement(sentence));
  }
}

function lineElement(sentence) {
  const line = document.createElement('div');
  line.dataset.traceLine = '';
  line.className = sentence.emphasis ? 'trace-line trace-line-key' : 'trace-line';

  const headline = document.createElement('div');
  headline.textContent = sentence.text;
  line.append(headline);

  for (const detail of sentence.lines ?? []) {
    const bullet = document.createElement('div');
    bullet.className = 'trace-detail';
    bullet.textContent = detail;
    line.append(bullet);
  }

  return line;
}
