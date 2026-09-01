// THE CONTROL. A deliberately crude keyword extractor, so that every number
// this harness prints has something to be compared against.
//
// WHY IT EXISTS. "The model gets 71% of these right" is not a finding, because
// nobody knows what a stupid program gets. This is the stupid program: a
// substring table, no cleverness, no learning, 72 lines of code. If the
// model cannot beat it by a distance worth paying per call for, that is the
// most useful thing this evaluation could tell anybody.
//
// IT IS ALSO WHAT MAKES `npm run eval:ai` RUNNABLE WITH NO API KEY. The harness
// reports the baseline offline and both rows when a key is present. A report
// that could only be produced by spending money is a report nobody runs.
//
// IT IS NOT THE FALLBACK PATH. When the model is unavailable in production the
// driver gets the structured picker and answers questions — a human, not this
// file. Nothing here is wired into src/.

import type { SymptomExtraction } from '../../src/ai/extraction.js';

type Rule = { value: string; phrases: string[] };

// Ordered: the first complaint whose phrases appear wins, so the specific
// cases (locked out, flat tyre) are checked before the general ones.
const COMPLAINT_RULES: Rule[] = [
  { value: 'LOCKED_OUT', phrases: ['locked out', 'locked my keys', 'keys inside', 'key is inside', 'chaabi andar', 'chaabi gaadi ke andar', 'andar band', 'locked the door', 'lock ho gaya'] },
  { value: 'FLAT_TYRE', phrases: ['flat tyre', 'flat tire', 'puncture', 'tyre burst', 'tyre phat', 'tyre ki hawa', 'tyre punctured', 'rear left tyre', 'front right'] },
  { value: 'STUCK_OR_DAMAGED', phrases: ['accident', 'collision', 'hit from behind', 'damage', 'stuck', 'phas gay', 'towed', 'will not move', 'nahi chal sakti', 'bent'] },
  { value: 'WONT_START', phrases: ['will not start', 'wont start', 'not start', 'start nahi', 'does not start', 'will not crank', 'nahi ho rahi', 'dead', 'jump start', 'not being recognised', 'key not detected', 'immobiliser'] },
  { value: 'NOISE_OR_SMELL', phrases: ['smoke', 'dhuan', 'burning smell', 'burning', 'steam', 'bhaap', 'grinding', 'whining', 'garam ho gay', 'overheat'] },
  { value: 'WARNING_LIGHT', phrases: ['warning light', 'warning lamp', 'light is on', 'light on hai', 'ka light', 'ev system', 'check engine'] },
];

const NO_CRANK_PHRASES = [
  'does not crank', 'will not crank', 'not turn over', 'never turns', 'nahi ghoom', 'bilkul nahi ghoom',
  'only a click', 'only clicking', 'just clicking', 'tik-tik', 'completely dead', 'bilkul dead',
  'no power at all', 'silent', 'nothing happens', 'kuch nahi hota', 'no cranking', 'engine nahi',
];

const CRANKS_PHRASES = [
  'turns over', 'cranks', 'crank ho raha', 'ghoom raha', 'engine ghoomta hai', 'churn', 'spluttered',
];

const LIGHT_PHRASES: Rule[] = [
  { value: 'BATTERY', phrases: ['battery light', 'battery warning', 'battery ka light', 'battery ka nishaan', 'charging light', 'battery symbol', 'battery system'] },
  { value: 'ENGINE', phrases: ['check engine', 'engine warning', 'engine light'] },
  { value: 'TEMPERATURE', phrases: ['temperature', 'heat warning', 'garmi ki warning', 'temperature ka meter'] },
  { value: 'OIL', phrases: ['oil light', 'oil warning'] },
  { value: 'BRAKE', phrases: ['brake warning', 'brake ki warning', 'brake fluid light', 'brake light'] },
  { value: 'EV_SYSTEM', phrases: ['ev system', 'high voltage', 'hv system', 'propulsion system'] },
];

const SOUND_RULES: Rule[] = [
  { value: 'GRINDING', phrases: ['grinding', 'ghar ghar', 'ghar-ghar', 'metal on metal', 'scraping', 'scrape'] },
  { value: 'WHINING', phrases: ['whining', 'whine', 'squealing', 'high pitched'] },
  { value: 'CLICKING', phrases: ['clicking', 'click', 'tik-tik', 'tik tik'] },
  { value: 'BANG', phrases: ['bang', 'dhamaka', 'loud bang', 'snapped', 'burst', 'zor ki awaaz'] },
  { value: 'NONE', phrases: ['no noise', 'koi awaaz nahi', 'silent', 'ek awaaz tak nahi'] },
];

const CANNOT_MOVE_PHRASES = [
  'will not move', 'cannot be driven', 'nahi chal sakti', 'chal nahi sakti', 'not drive', 'hil nahi',
  'towed', 'wheels will not turn', 'chalane layak nahi',
];

const CAN_MOVE_PHRASES = ['still drive', 'chal sakti hai', 'thodi chal rahi', 'drivable', 'still moving'];

export function keywordExtraction(text: string): SymptomExtraction {
  const haystack = text.toLowerCase();

  return {
    primaryComplaint: (firstMatch(haystack, COMPLAINT_RULES) ??
      'UNKNOWN') as SymptomExtraction['primaryComplaint'],
    // Checked before the positive phrases: "the engine does not crank"
    // contains "crank", and a substring table has no other way to tell the two
    // apart. That fragility is the point of a control.
    engineCranks: containsAny(haystack, NO_CRANK_PHRASES)
      ? 'NO'
      : containsAny(haystack, CRANKS_PHRASES)
        ? 'YES'
        : 'NOT_STATED',
    warningLights: LIGHT_PHRASES.filter((rule) => containsAny(haystack, rule.phrases)).map(
      (rule) => rule.value,
    ) as SymptomExtraction['warningLights'],
    unusualSound: (firstMatch(haystack, SOUND_RULES) ??
      'NOT_STATED') as SymptomExtraction['unusualSound'],
    vehicleMoves: containsAny(haystack, CANNOT_MOVE_PHRASES)
      ? 'NO'
      : containsAny(haystack, CAN_MOVE_PHRASES)
        ? 'YES'
        : 'NOT_STATED',
    // The control does not attempt safety or vehicle context. Both are things
    // the driver is shown and confirms, and inventing a keyword table for them
    // would make the comparison flattering rather than fair.
    urgencySignals: [],
    vehicleContext: { make: null, model: null, fuel: 'UNKNOWN' },
    evidence: 'keyword baseline',
  };
}

function firstMatch(haystack: string, rules: Rule[]): string | null {
  for (const rule of rules) {
    if (containsAny(haystack, rule.phrases)) return rule.value;
  }
  return null;
}

function containsAny(haystack: string, phrases: string[]): boolean {
  return phrases.some((phrase) => haystack.includes(phrase));
}
