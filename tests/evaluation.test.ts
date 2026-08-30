// The harness's own two load-bearing properties.
//
// A measuring instrument that is not reproducible is an anecdote, and one that
// quietly re-implements the thing it measures is a tautology. Both are easy to
// break by accident and neither shows up as a failure anywhere else, so both
// are pinned here.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildScenario, SCENARIO_NAMES } from '../evaluation/scenarios/index.js';
import { POLICIES, policyByName } from '../evaluation/policies/index.js';
import { runScenario } from '../evaluation/runner.js';
import { computeMetrics, gini } from '../evaluation/metrics.js';

describe('the harness is reproducible', () => {
  // The property the whole phase rests on: same seed, same numbers. If this
  // fails, every table the harness has ever printed is an anecdote.
  it('produces identical metrics for the same seed', async () => {
    const policy = policyByName('capability-aware-global');

    const first = buildScenario('capability-scarcity', 4242);
    const second = buildScenario('capability-scarcity', 4242);

    const a = computeMetrics(
      await runScenario(first, policy),
      first.snapshot.technicians.map((technician) => technician.id),
    );
    const b = computeMetrics(
      await runScenario(second, policy),
      second.snapshot.technicians.map((technician) => technician.id),
    );

    // Wall clock is the one field that legitimately differs run to run.
    const { solverWallClockP95Ms: _a, ...aStable } = a;
    const { solverWallClockP95Ms: _b, ...bStable } = b;
    expect(aStable).toEqual(bStable);
  });

  it('produces different scenarios for different seeds', async () => {
    const one = buildScenario('normal-day', 1);
    const two = buildScenario('normal-day', 2);
    expect(one.jobs.map((job) => job.trueFault)).not.toEqual(two.jobs.map((job) => job.trueFault));
  });

  // Every scenario has to be buildable and non-empty, or a silently empty
  // scenario would report a flawless 0/0 result.
  it('builds every named scenario with jobs and a crewed fleet', () => {
    for (const name of SCENARIO_NAMES) {
      const scenario = buildScenario(name, 7);
      expect(scenario.jobs.length, name).toBeGreaterThan(0);
      expect(
        scenario.snapshot.units.filter((unit) => unit.currentTechnicianId).length,
        name,
      ).toBeGreaterThan(0);
    }
  });

  // Every fault a scenario invents must be a real fault code. This is the
  // check that would have caught `WHEEL_DAMAGE` and `ELECTRICAL_FAULT` on the
  // first run instead of after a full table of numbers had been printed from
  // distributions that were silently all-zero.
  it('gives every job a distribution that sums to one', () => {
    for (const name of SCENARIO_NAMES) {
      for (const entry of buildScenario(name, 11).jobs) {
        const total = Object.values(entry.job.faultDistribution).reduce(
          (sum, value) => sum + value,
          0,
        );
        expect(total, `${name} / ${entry.job.id}`).toBeCloseTo(1, 6);
      }
    }
  });
});

describe('the harness measures the production engine', () => {
  // THE PHASE'S OWN REQUIREMENT, as a test rather than a promise: a parallel
  // implementation would prove only that the simulator agrees with itself.
  it('imports src/engine from the policies that make decisions', () => {
    const files = ['policies/greedy.ts', 'policies/global.ts'];
    for (const file of files) {
      const source = readFileSync(join('evaluation', file), 'utf8');
      expect(source, file).toMatch(/from '\.\.\/\.\.\/src\/engine\//);
    }
  });

  // The cost function must stay free of a fairness term (the phase says Gini
  // is measured, never optimised). Asserted against the real file.
  it('has no fairness term in the production cost function', () => {
    const cost = readFileSync(join('src', 'engine', 'cost.ts'), 'utf8');
    expect(cost).not.toMatch(/fairness|gini|earnings/i);
  });

  // No solver library anywhere in the harness either — the Hungarian
  // implementation under test is the hand-written one.
  it('pulls in no external solver library', () => {
    const packageJson = readFileSync('package.json', 'utf8');
    expect(packageJson).not.toMatch(/or-tools|munkres|scipy|hungarian/i);
  });

  it('has a policy for each of the four named baselines', () => {
    expect(POLICIES.map((policy) => policy.name).sort()).toEqual([
      'capability-aware-global',
      'fifo',
      'nearest-unit',
      'skill-aware',
    ]);
  });

  it('ships every scenario the build plan names', () => {
    const files = readdirSync(join('evaluation', 'scenarios'));
    expect(files).toContain('index.ts');
    expect([...SCENARIO_NAMES].sort()).toEqual([
      'ambiguous-diagnosis',
      'capability-scarcity',
      'monsoon-surge',
      'normal-day',
      'technician-dropout',
    ]);
  });
});

describe('gini', () => {
  it('is zero when everyone earns the same', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 10);
  });

  it('approaches one when a single technician takes everything', () => {
    expect(gini([0, 0, 0, 100])).toBeCloseTo(0.75, 10);
  });

  // The reason idle technicians are counted: dropping them turns a badly
  // skewed distribution into a perfectly even one.
  it('counts technicians who earned nothing', () => {
    expect(gini([100, 100])).toBeCloseTo(0, 10);
    expect(gini([100, 100, 0, 0])).toBeGreaterThan(0.4);
  });
});
