// THE ENGINE NARRATING ITSELF — the wording, asserted.
//
// These are the sentences a dispatcher reads while a solve runs and after they
// click a job, and they are worth pinning for the same reason the unassigned
// breakdown is: they are the project's argument, said out loud. The rules they
// have to keep are specific and checkable —
//
//   * every figure carries what it counts, so no sentence contains a bare
//     number with nothing attached to it;
//   * no reason code appears as an enum in prose;
//   * nothing is claimed that the engine did not compute.
//
// The narration modules are pure — no DOM, no fetch — which is what makes this
// possible at all. The panels that render them are exercised in a browser.

import { describe, expect, it } from 'vitest';
import { stageSentence } from '../public/js/panels/solveNarration.js';
import { narrateDecision } from '../public/js/panels/decisionNarration.js';
import { countUnassignedByReason, addBand } from '../src/engine/trace.js';
import type { SafetyBandTrace } from '../src/engine/trace.js';
import type { SafetyLevelSnapshot } from '../src/engine/candidates.js';

describe('the solve trace', () => {
  it('says what each number counts', () => {
    const sentence = stageSentence({
      stage: 'PENDING',
      elapsedMs: 0,
      jobCount: 25,
      unitCount: 24,
      availableUnitCount: 18,
      technicianCount: 30,
    });

    expect(sentence?.text).toBe(
      '25 jobs are waiting for a crew. 18 of the 24 units on the board are free right now, ' +
        'crewed from 30 technicians.',
    );
  });

  it('agrees with itself about one job and one unit', () => {
    const sentence = stageSentence({
      stage: 'PENDING',
      elapsedMs: 0,
      jobCount: 1,
      unitCount: 1,
      availableUnitCount: 1,
      technicianCount: 1,
    });

    expect(sentence?.text).toContain('1 job is waiting');
    expect(sentence?.text).toContain('1 technician.');
  });

  it('turns the reason codes into phrases and never prints the code', () => {
    const sentence = stageSentence({
      stage: 'FEASIBILITY',
      elapsedMs: 900,
      optionCount: 600,
      feasibleCount: 318,
      rejectedCount: 282,
      rejectedByCode: {
        CAPABILITY_MISSING: 184,
        PART_UNAVAILABLE: 64,
        NO_TECHNICIAN_ON_SHIFT: 34,
      },
    });

    expect(sentence?.text).toBe(
      '318 of them could actually do the work. 282 were ruled out before cost was looked at:',
    );
    expect(sentence?.lines).toEqual([
      '184 no crew with the right skill',
      '64 the part is not on board and cannot be collected in time',
      '34 nobody on shift within reach',
    ]);
    expect(sentence?.lines.join(' ')).not.toMatch(/[A-Z]{3,}_[A-Z]/);
  });

  // THE LINE THE WHOLE FEATURE EXISTS FOR. Invariant 4 is a lexicographic
  // ordering above the cost function, and this is the one place a person can
  // watch it happen: the units the dangerous round took are gone before the
  // ordinary round is solved, and no amount of cost can reach back across that.
  it('shows the safety bands handing units down, most dangerous first', () => {
    const sentence = stageSentence({
      stage: 'SAFETY_BANDS',
      elapsedMs: 1200,
      planLabel: 'BALANCED',
      bands: [
        { level: 'HIGH_RISK', jobCount: 5, assignedCount: 5, unitsOffered: 24, unitsLeftBelow: 19 },
        { level: 'ELEVATED', jobCount: 3, assignedCount: 3, unitsOffered: 19, unitsLeftBelow: 16 },
        { level: 'NORMAL', jobCount: 17, assignedCount: 7, unitsOffered: 16, unitsLeftBelow: 9 },
      ],
    });

    expect(sentence?.text).toBe(
      'Placed the 5 most dangerous jobs first, in a round of their own — before cost was compared at all.',
    );
    expect(sentence?.lines[0]).toBe(
      'most dangerous round — 5 jobs, 5 of the 24 free units taken, leaving 19 for the rounds below',
    );
    expect(sentence?.emphasis).toBe(true);
  });

  // A board with nothing dangerous on it must not imply an ordering that did
  // not happen. Claiming safety "went first" when every job was NORMAL would be
  // the one kind of lie this screen exists to avoid.
  it('says plainly when the ordering had nothing to separate', () => {
    const sentence = stageSentence({
      stage: 'SAFETY_BANDS',
      elapsedMs: 10,
      planLabel: 'BALANCED',
      bands: [
        { level: 'NORMAL', jobCount: 4, assignedCount: 4, unitsOffered: 9, unitsLeftBelow: 5 },
      ],
    });

    expect(sentence?.text).toContain('Every job on the board is at the same safety level');
    expect(sentence?.text).not.toContain('first');
  });

  it('names the terms and the plans rather than counting silently', () => {
    const sentence = stageSentence({
      stage: 'COST',
      elapsedMs: 1300,
      termCount: 8,
      planLabels: ['FASTEST_RESOLUTION', 'LOWEST_COST', 'BALANCED', 'PROTECT_CONTRACTS'],
      zonePartitioned: false,
    });

    expect(sentence?.text).toContain('across 8 weighted terms');
    expect(sentence?.text).toContain('solved the whole board 4 ways');
    // The plans are named in words, not as the engine's constants.
    expect(sentence?.text).toContain(
      'the fastest-resolution, lowest-cost, balanced and contract-protecting plans',
    );
    expect(sentence?.text).not.toContain('FASTEST_RESOLUTION');
    expect(sentence?.lines).toEqual([]);
  });

  it('admits the zone approximation when it was used', () => {
    const sentence = stageSentence({
      stage: 'COST',
      elapsedMs: 1300,
      termCount: 8,
      planLabels: ['BALANCED'],
      zonePartitioned: true,
    });

    expect(sentence?.lines[0]).toContain('split by zone');
    expect(sentence?.lines[0]).toContain('can lose a better crew across the line');
  });

  it('says how many jobs are still waiting, and why', () => {
    const sentence = stageSentence({
      stage: 'OUTCOME',
      elapsedMs: 1400,
      planLabel: 'BALANCED',
      assignedCount: 15,
      unassignedCount: 10,
      unassignedByReason: { CAPABILITY_MISSING: 6, SLA_UNREACHABLE: 3, CONTENTION: 1 },
    });

    expect(sentence?.text).toBe('15 jobs have a crew. 10 do not:');
    expect(sentence?.lines).toEqual([
      '6 no crew holds the skills the fault needs',
      '3 unreachable within SLA',
      '1 lost a unit to a higher-priority job',
    ]);
  });

  it('states the runtime in the unit it was measured in', () => {
    expect(
      stageSentence({ stage: 'DONE', elapsedMs: 1400, wallClockMs: 1400, timedOut: false, unplannedCount: 0 })
        ?.text,
    ).toBe('1.4 seconds, start to finish.');

    expect(
      stageSentence({ stage: 'DONE', elapsedMs: 240, wallClockMs: 240, timedOut: false, unplannedCount: 0 })
        ?.text,
    ).toBe('240 milliseconds, start to finish.');
  });

  it('says when the planner ran out of time, rather than reporting a clean run', () => {
    const sentence = stageSentence({
      stage: 'DONE',
      elapsedMs: 2000,
      wallClockMs: 2000,
      timedOut: true,
      unplannedCount: 4,
    });

    expect(sentence?.lines[0]).toContain('ran out of time');
    expect(sentence?.lines[0]).toContain('4 jobs were never looked at');
  });
});

// ---------------------------------------------------------------------------
describe('one job, as prose', () => {
  const chosenOption = {
    id: 'opt-balanced',
    unitId: 'VAN-07',
    technicianId: 'tech-04',
    technicianName: 'Ravi',
    feasible: true,
    estimatedTravelMinutes: 7,
    coveredFaultProbability: 0.92,
    partSourcing: { status: 'IN_VAN', detourMinutes: 0, missingSkus: [] },
    totalCost: 41.2,
    costBreakdown: { weightVector: 'BALANCED', operationalCost: { value: 30_000, unit: 'paise' } },
  };

  const alternativeOption = {
    id: 'opt-fastest',
    unitId: 'VAN-12',
    technicianId: 'tech-09',
    technicianName: 'Priya',
    feasible: true,
    estimatedTravelMinutes: 11,
    coveredFaultProbability: 0.92,
    partSourcing: { status: 'IN_VAN', detourMinutes: 0, missingSkus: [] },
    totalCost: 44.4,
    costBreakdown: {
      weightVector: 'FASTEST_RESOLUTION',
      operationalCost: { value: 34_000, unit: 'paise' },
    },
  };

  function decisionWith(overrides = {}) {
    return {
      job: { id: 'job-1', status: 'PLANNED', safetyLevel: 'NORMAL', zoneId: 'zone-1' },
      solverRun: { id: 'run-1' },
      selectedOptionId: null,
      overrideReasonCode: null,
      chosen: [chosenOption, alternativeOption],
      rejected: [
        { unitId: 'BIKE-01', rejectionCode: 'CAPABILITY_MISSING' },
        { unitId: 'BIKE-02', rejectionCode: 'CAPABILITY_MISSING' },
        { unitId: 'VAN-02', rejectionCode: 'PART_UNAVAILABLE' },
      ],
      ...overrides,
    };
  }

  it('names the crew, what was ruled out, and what the alternative costs', () => {
    const narration = narrateDecision(decisionWith());

    expect(narration?.title).toBe('Why Ravi in VAN-07?');
    expect(narration?.paragraphs[0]).toBe(
      '3 crews were ruled out before cost was compared — ' +
        '2 no crew with the right skill · 1 the part is not on board and cannot be collected in time.',
    );
    expect(narration?.paragraphs[1]).toBe(
      'Ravi in VAN-07 is the crew the recommended plan puts forward: 7 minutes away, ' +
        'the part already on board and covering 92% of what we currently think is wrong.',
    );
    expect(narration?.paragraphs[2]).toBe(
      'The fastest-resolution plan would have sent Priya in VAN-12 instead — ' +
        '4 minutes further away and ₹40 more to run.',
    );
    expect(narration?.override).toBeNull();
  });

  // The two are genuinely different claims and the sentence has to tell them
  // apart: one is a decision somebody put their name to, the other is a
  // proposal nobody has taken yet.
  it('distinguishes a crew a human recorded from one the solver proposes', () => {
    const narration = narrateDecision(
      decisionWith({ selectedOptionId: 'opt-fastest', overrideReasonCode: 'ROAD_CLOSED' }),
    );

    expect(narration?.title).toBe('Why Priya in VAN-12?');
    expect(narration?.paragraphs[1]).toContain('is the crew a dispatcher recorded for this job');
    expect(narration?.override).toBe(
      'A dispatcher overrode the recommendation. The reason they gave: "ROAD_CLOSED".',
    );
  });

  it('says the safety ordering applied to this job, when it did', () => {
    const narration = narrateDecision(
      decisionWith({
        job: { id: 'job-1', status: 'PLANNED', safetyLevel: 'HIGH_RISK', zoneId: 'zone-1' },
      }),
    );

    expect(narration?.paragraphs[0]).toContain('matched in a round of its own');
    expect(narration?.paragraphs[0]).toContain('before any cost was compared');
  });

  it('says nothing about a safety ordering for an ordinary job', () => {
    const narration = narrateDecision(decisionWith());
    expect(narration?.paragraphs.join(' ')).not.toContain('round of its own');
  });

  // The record holds every rejected option but only the feasible ones a plan
  // took (src/commit/persistSolverRun.ts), so "of the six who could" is a number
  // this panel does not have. It must not print one.
  it('never claims a count of feasible crews it was not given', () => {
    const narration = narrateDecision(decisionWith());
    expect(narration?.paragraphs.join(' ')).not.toMatch(/of the \d+ (that|who) could/);
  });

  it('has nothing to say about a job no solver run has considered', () => {
    expect(narrateDecision({ job: { id: 'job-1' }, solverRun: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The engine-side facts the sentences above are built from.
describe('the stage facts', () => {
  it('gives every unassigned job exactly one reason, so the counts add up', () => {
    const counts = countUnassignedByReason(
      ['a', 'b', 'c'],
      [
        { jobId: 'a', code: 'CAPABILITY_MISSING' },
        { jobId: 'a', code: 'CAPABILITY_MISSING' },
        { jobId: 'a', code: 'SLA_UNREACHABLE' },
        { jobId: 'b', code: 'SLA_UNREACHABLE' },
        // c was refused by nothing: it lost a unit to another job.
        { jobId: 'somebody-else', code: 'PART_UNAVAILABLE' },
      ],
    );

    expect(counts).toEqual({ CAPABILITY_MISSING: 1, SLA_UNREACHABLE: 1, CONTENTION: 1 });
    expect(Object.values(counts).reduce((total, n) => total + n, 0)).toBe(3);
  });

  // A zone-partitioned solve runs the bands once per zone. Reporting them
  // separately would put "the high-risk round" on screen three times with
  // numbers a reader cannot add up.
  it('sums a band across zone partitions', () => {
    const totals = new Map<SafetyLevelSnapshot, SafetyBandTrace>();
    addBand(totals, { level: 'HIGH_RISK', jobCount: 2, assignedCount: 2, unitsOffered: 9, unitsLeftBelow: 7 });
    addBand(totals, { level: 'HIGH_RISK', jobCount: 1, assignedCount: 0, unitsOffered: 4, unitsLeftBelow: 4 });

    expect(totals.get('HIGH_RISK')).toEqual({
      level: 'HIGH_RISK',
      jobCount: 3,
      assignedCount: 2,
      unitsOffered: 13,
      unitsLeftBelow: 11,
    });
  });
});
