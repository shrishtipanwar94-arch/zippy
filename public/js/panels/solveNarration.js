// THE SOLVE, IN SENTENCES — one line per stage the engine reported.
//
// "600 options" tells a dispatcher nothing. "We paired every job with every
// crew that could take it — 600 combinations" tells them what the number
// counts, and the number is the same number. That is the whole rule this file
// follows: every figure carries what it counts, no reason code appears as an
// enum, and nothing is said that the engine did not compute.
//
// PURE, AND THAT IS WHY IT IS ITS OWN FILE. `stageSentence` takes a stage and
// returns text; it touches no DOM and reads no global state, so
// tests/narration.test.ts can assert the actual wording against actual stage
// records. The panel that puts these on screen is solveTrace.js.
//
// THE FIFTH LINE IS THE ONE THAT MATTERS. Safety is a lexicographic ordering
// above the cost function (invariant 4), not a heavy weight inside it, and
// until now nothing on screen showed that happening. The SAFETY_BANDS stage
// carries how many units each band took and how many it left for the bands
// below, which is the ordering stated as arithmetic: no amount of cost can move
// a unit upward across those numbers, because by the time the band below is
// solved the unit is already gone.

import { describeCrewRejections, describeJobRejections } from './rejectionWords.js';
import { describePlans } from './planWords.js';

// The safety levels in the words an operator would use. The enum is never
// printed in a sentence — it is printed as a badge elsewhere on the console,
// where a code is the right thing to show.
const BAND_WORDS = {
  HIGH_RISK: 'most dangerous',
  ELEVATED: 'elevated risk',
  NORMAL: 'ordinary',
};

// ---------------------------------------------------------------------------
// One stage, as a headline and any number of supporting lines. Everything it
// says comes out of the stage it was handed — nothing is read from the finished
// report, because a stage line is written before the report exists.
export function stageSentence(stage) {
  if (!stage) return null;
  if (stage.stage === 'PENDING') return pending(stage);
  if (stage.stage === 'CANDIDATES') return candidates(stage);
  if (stage.stage === 'FEASIBILITY') return feasibility(stage);
  if (stage.stage === 'SAFETY_BANDS') return safetyBands(stage);
  if (stage.stage === 'COST') return cost(stage);
  if (stage.stage === 'OUTCOME') return outcome(stage);
  if (stage.stage === 'DONE') return done(stage);
  return null;
}

function pending(stage) {
  return {
    text:
      `${plural(stage.jobCount, 'job is', 'jobs are')} waiting for a crew. ` +
      `${stage.availableUnitCount} of the ${stage.unitCount} units on the board are free right now, ` +
      `crewed from ${plural(stage.technicianCount, 'technician', 'technicians')}.`,
    lines: [],
  };
}

function candidates(stage) {
  return {
    text:
      'Paired every job with every crew that could take it — ' +
      `${plural(stage.optionCount, 'combination', 'combinations')} to consider.`,
    lines: [],
  };
}

function feasibility(stage) {
  if (stage.rejectedCount === 0) {
    return { text: `All ${stage.optionCount} of them could do the work. Nothing was ruled out.`, lines: [] };
  }
  return {
    text:
      `${stage.feasibleCount} of them could actually do the work. ` +
      `${stage.rejectedCount} were ruled out before cost was looked at:`,
    lines: describeCrewRejections(stage.rejectedByCode),
  };
}

// INVARIANT 4, ON SCREEN. See the file header.
function safetyBands(stage) {
  const bands = stage.bands ?? [];
  const dangerous = bands.filter((band) => band.level !== 'NORMAL');

  if (dangerous.length === 0) {
    return {
      text:
        'Every job on the board is at the same safety level, so the ordering had nothing to ' +
        'separate — one round, ranked by cost.',
      lines: [],
      emphasis: true,
    };
  }

  const first = dangerous[0];
  return {
    text:
      `Placed the ${first.jobCount} ${BAND_WORDS[first.level] ?? first.level} ` +
      `${first.jobCount === 1 ? 'job' : 'jobs'} first, in a round of their own — ` +
      'before cost was compared at all.',
    lines: bands.map(bandLine),
    emphasis: true,
  };
}

function bandLine(band) {
  const took =
    `${BAND_WORDS[band.level] ?? band.level} round — ` +
    `${plural(band.jobCount, 'job', 'jobs')}, ` +
    `${band.assignedCount} of the ${band.unitsOffered} free units taken`;

  if (band.unitsLeftBelow === band.unitsOffered) {
    return `${took}, so all ${band.unitsOffered} stayed available to the rounds below`;
  }
  return `${took}, leaving ${band.unitsLeftBelow} for the rounds below`;
}

function cost(stage) {
  const lines = [];
  if (stage.zonePartitioned) {
    lines.push(
      'the board was big enough to split by zone, so each zone was solved on its own — ' +
        'a job near a boundary can lose a better crew across the line',
    );
  }
  return {
    text:
      `Ranked everything that was left by cost, across ${stage.termCount} weighted terms, ` +
      `and solved the whole board ${plural(stage.planLabels.length, 'way', 'ways')}: ` +
      `${describePlans(stage.planLabels)}.`,
    lines,
  };
}

function outcome(stage) {
  if (stage.unassignedCount === 0) {
    return { text: `Every one of the ${stage.assignedCount} jobs has a crew.`, lines: [] };
  }
  return {
    text:
      `${plural(stage.assignedCount, 'job has', 'jobs have')} a crew. ` +
      `${stage.unassignedCount} ${stage.unassignedCount === 1 ? 'does' : 'do'} not:`,
    // One reason per job still waiting, in the same words and the same order the
    // plan card underneath uses — both go through describeJobRejections, so the
    // two cannot tell different stories about the same board.
    lines: describeJobRejections(stage.unassignedByReason),
  };
}

function done(stage) {
  const lines = [];
  if (stage.timedOut) {
    lines.push(
      `the planner ran out of time — ${plural(stage.unplannedCount, 'job was', 'jobs were')} ` +
        'never looked at and keep whichever crew they already had',
    );
  }
  return { text: `${duration(stage.wallClockMs)}, start to finish.`, lines };
}

// Sub-second runs are the normal case and "0.1 seconds" reads as a rounding
// error rather than a measurement, so they are stated in the unit they were
// measured in.
function duration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} milliseconds`;
  return `${(milliseconds / 1000).toFixed(1)} seconds`;
}

// A number never appears without the thing it counts, which means the noun has
// to agree with it.
function plural(count, singular, plural_) {
  return `${count} ${count === 1 ? singular : plural_}`;
}
