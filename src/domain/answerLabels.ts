// THE WORDS ON THE ANSWER BUTTONS.
//
// Intake's questions are already plain English — "What do you hear when you
// try to start it?" — but their ANSWERS are codes, because the likelihood
// tables in questions.ts are keyed on them and the maths has to stay keyed on
// something stable. Walking the driver's page in a browser found the
// consequence: four buttons reading CLICKING, GRINDING, SILENCE, OTHER, on the
// one surface in this product that is supposed to contain no enum at all.
//
// So the codes stay in the domain and stop at the view. This is the same
// division as driverNarrative.ts — one place, on the server, where a code
// becomes something a person reads — and the reason it is here rather than
// beside the questions is that a likelihood row and a button label are edited
// by different people for different reasons.
//
// A MISSING LABEL IS A BUILD FAILURE, not a fallback. tests/driverSurface
// walks every answer of every question and asserts each has an entry, so a
// phase that adds a question cannot leak its codes onto this screen by
// forgetting to word them. That is deliberately stricter than the whitelist in
// driverUpdates.ts, where dropping an unworded event is harmless — dropping an
// answer would leave a question a driver cannot answer.

const ANSWER_LABELS: Record<string, string> = {
  // Yes / no / not sure, shared by several questions.
  YES: 'Yes',
  NO: 'No',
  UNSURE: 'I am not sure',

  // Dashboard lights.
  BRIGHT: 'They come on brightly',
  DIM_OR_NONE: 'They are dim, or nothing comes on',

  // What the driver hears when they try to start.
  CLICKING: 'A rapid clicking',
  GRINDING: 'A harsh grinding',
  SILENCE: 'Nothing at all',
  OTHER: 'Something else',

  // Fuel.
  HAS_FUEL: 'There is fuel in it',
  EMPTY: 'It is empty, or close to it',

  // The key.
  KEY_NOT_DETECTED: 'The car says it cannot find the key',
  NORMAL: 'The key seems normal',
};

export type AnswerOption = {
  // What goes back to the API. The client sends this, never the label.
  value: string;
  // What the driver reads.
  label: string;
};

export function hasAnswerLabel(code: string): boolean {
  return code in ANSWER_LABELS;
}

export function answerOptions(codes: string[]): AnswerOption[] {
  return codes.map((code) => ({
    value: code,
    // A code with no entry would be a bug caught by the test, so falling back
    // to the code itself here is a safety net that should never fire — not a
    // supported path.
    label: ANSWER_LABELS[code] ?? code,
  }));
}
