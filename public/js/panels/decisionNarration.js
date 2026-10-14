// ONE JOB'S DECISION, AS A PERSON WOULD SAY IT.
//
// The cost table underneath this answers "what did the arithmetic come to".
// This answers the question a dispatcher actually asks out loud — why this
// crew, who else was there, and what the alternative would have cost — using
// the same stored rows the table reads. It computes no new numbers.
//
// WHAT THE RECORD ACTUALLY CONTAINS, because the wording has to stay inside it.
// `dispatch_options` holds EVERY rejected option for a job (that is the half
// the panel exists for) but only the FEASIBLE options a plan actually picked —
// see src/commit/persistSolverRun.ts, which deliberately does not write a row
// for a feasible option no plan chose. So this file can say how many crews were
// ruled out and why, and it can say what a competing plan would have done
// instead. It must NOT say "of the six who could, this one was cheapest",
// because the six were never written down and a count nobody can check is
// exactly the kind of sentence this project does not print.
//
// PURE. No DOM, no state — inspector.js renders what this returns, and
// tests/narration.test.ts asserts the wording.

import { describeCrewRejections } from './rejectionWords.js';
import { planWord } from './planWords.js';

const RECOMMENDED = 'BALANCED';

const SAFETY_WORDS = {
  HIGH_RISK: 'the most dangerous footing there is',
  ELEVATED: 'an elevated-risk footing',
};

// Where the winner came from, and therefore what the sentence may claim about
// it. A crew a dispatcher recorded is a decision; a crew the recommended plan
// puts forward is a proposal, and saying the second as though it were the first
// is how a screen starts lying quietly.
const HOW_CHOSEN_WORDS = {
  RECORDED: 'is the crew a dispatcher recorded for this job',
  RECOMMENDED: 'is the crew the recommended plan puts forward',
  CHEAPEST: 'is the cheapest crew on the record for this job',
};

export function narrateDecision(decision) {
  if (!decision || !decision.solverRun) return null;

  const chosen = decision.chosen ?? [];
  const rejected = decision.rejected ?? [];
  if (chosen.length === 0 && rejected.length === 0) return null;

  const winner = pickWinner(decision, chosen);
  const paragraphs = [];

  const safety = safetySentence(decision.job);
  if (safety) paragraphs.push(safety);

  paragraphs.push(ruledOutSentence(rejected));

  if (!winner) {
    paragraphs.push('No crew came through feasible, so there is nobody to send yet.');
    return { title: 'Why nobody yet?', paragraphs, override: overrideSentence(decision) };
  }

  paragraphs.push(winnerSentence(winner));

  const alternative = pickAlternative(winner, chosen);
  if (alternative) paragraphs.push(alternativeSentence(winner, alternative));

  return {
    title: `Why ${crewName(winner.option)}?`,
    paragraphs,
    // KEPT OUT OF THE PARAGRAPHS ON PURPOSE. An overridden decision is the one
    // case where the numbers underneath do NOT explain the assignment, so the
    // panel gives it its own amber note rather than a fourth sentence an
    // operator scanning the prose can slide past.
    override: overrideSentence(decision),
  };
}

function overrideSentence(decision) {
  if (!decision.overrideReasonCode) return null;
  return `A dispatcher overrode the recommendation. The reason they gave: "${decision.overrideReasonCode}".`;
}

// ---------------------------------------------------------------------------
// WHO WON, and how confidently we can say so.
function pickWinner(decision, chosen) {
  if (chosen.length === 0) return null;

  const recorded = chosen.find((option) => option.id === decision.selectedOptionId);
  if (recorded) return { option: recorded, how: 'RECORDED' };

  const recommended = chosen.find(
    (option) => option.costBreakdown?.weightVector === RECOMMENDED,
  );
  if (recommended) return { option: recommended, how: 'RECOMMENDED' };

  const cheapest = [...chosen].sort((a, b) => totalCost(a) - totalCost(b))[0];
  return { option: cheapest, how: 'CHEAPEST' };
}

// The cheapest crew on the record that is not the winner's. Deduplicated by
// unit: the same van chosen under three weight vectors is three rows and one
// alternative, and listing it three times would invent a choice that was never
// there.
function pickAlternative(winner, chosen) {
  const others = chosen.filter((option) => option.unitId !== winner.option.unitId);
  if (others.length === 0) return null;

  const byUnit = new Map();
  for (const option of others) {
    const existing = byUnit.get(option.unitId);
    if (!existing || totalCost(option) < totalCost(existing)) byUnit.set(option.unitId, option);
  }

  return [...byUnit.values()].sort((a, b) => totalCost(a) - totalCost(b))[0];
}

// ---------------------------------------------------------------------------
// The sentences.

function safetySentence(job) {
  const words = SAFETY_WORDS[job?.safetyLevel];
  if (!words) return null;
  return (
    `This job is on ${words}, so it was matched in a round of its own, ` +
    'ahead of every less dangerous job — before any cost was compared.'
  );
}

function ruledOutSentence(rejected) {
  if (rejected.length === 0) {
    return 'No crew was ruled out for this job: every pairing the solver looked at could have taken it.';
  }

  const counts = {};
  for (const option of rejected) {
    const code = option.rejectionCode ?? 'UNKNOWN';
    counts[code] = (counts[code] ?? 0) + 1;
  }

  const crews = rejected.length === 1 ? 'One crew was' : `${rejected.length} crews were`;
  return `${crews} ruled out before cost was compared — ${describeCrewRejections(counts).join(' · ')}.`;
}

function winnerSentence(winner) {
  const option = winner.option;
  const how = HOW_CHOSEN_WORDS[winner.how] ?? HOW_CHOSEN_WORDS.CHEAPEST;
  const clauses = [];

  if (Number.isFinite(Number(option.estimatedTravelMinutes))) {
    clauses.push(`${minutes(option.estimatedTravelMinutes)} away`);
  }

  const parts = partsClause(option.partSourcing);
  if (parts) clauses.push(parts);

  if (Number.isFinite(Number(option.coveredFaultProbability))) {
    clauses.push(
      `covering ${percent(option.coveredFaultProbability)} of what we currently think is wrong`,
    );
  }

  const detail = clauses.length > 0 ? `: ${joinClauses(clauses)}.` : '.';
  return `${crewName(option)} ${how}${detail}`;
}

function partsClause(sourcing) {
  if (!sourcing) return null;
  if (sourcing.status === 'IN_VAN') return 'the part already on board';
  if (sourcing.status === 'WORKSHOP_RUN') {
    return `collecting the part on the way, ${minutes(sourcing.detourMinutes)} out of the way`;
  }
  // NOT_MODELLED means nobody looked at parts on this run, and UNAVAILABLE
  // cannot reach a feasible option at all. Neither is a thing to claim.
  return null;
}

function alternativeSentence(winner, alternative) {
  const label = alternative.costBreakdown?.weightVector;
  const opening = label
    ? `The ${planWord(label)} plan would have sent ${crewName(alternative)} instead`
    : `Next on the record was ${crewName(alternative)}`;

  const clauses = [];

  const travelGap = Number(alternative.estimatedTravelMinutes) - Number(winner.option.estimatedTravelMinutes);
  if (Number.isFinite(travelGap) && Math.abs(travelGap) >= 0.5) {
    clauses.push(
      travelGap > 0
        ? `${minutes(Math.abs(travelGap))} further away`
        : `${minutes(Math.abs(travelGap))} nearer`,
    );
  }

  // Operational cost is the one term denominated in money, so it is the one
  // that can be quoted as money. The combined score is not rupees and is never
  // written as though it were.
  const moneyGap = paise(alternative, 'operationalCost') - paise(winner.option, 'operationalCost');
  if (Number.isFinite(moneyGap) && Math.abs(moneyGap) >= 100) {
    clauses.push(
      moneyGap > 0 ? `₹${rupees(moneyGap)} more to run` : `₹${rupees(-moneyGap)} less to run`,
    );
  }

  if (clauses.length === 0) return `${opening}.`;
  return `${opening} — ${joinClauses(clauses)}.`;
}

// ---------------------------------------------------------------------------
// Small readings of one option.

function crewName(option) {
  const who = option.technicianName ?? option.technicianId;
  return `${who} in ${option.unitId}`;
}

function totalCost(option) {
  const value = Number(option.totalCost ?? option.costBreakdown?.total);
  return Number.isFinite(value) ? value : Infinity;
}

function paise(option, term) {
  return Number(option?.costBreakdown?.[term]?.value ?? NaN);
}

function rupees(value) {
  return Math.round(Math.abs(value) / 100).toLocaleString('en-IN');
}

function minutes(value) {
  const number = Number(value);
  const rounded = number >= 10 ? Math.round(number) : Math.round(number * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'minute' : 'minutes'}`;
}

function percent(probability) {
  return `${Math.round(Number(probability) * 100)}%`;
}

// "a, b and c" — the list a person would say, not a comma-joined array.
function joinClauses(clauses) {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}
