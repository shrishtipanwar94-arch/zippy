// npm run eval — the entry point for all three modes.
//
//   npm run eval                                    every scenario, every policy
//   npm run eval -- --scenario monsoon-surge        one scenario
//   npm run eval -- --seed 48291                    a different draw
//   npm run eval -- --policies nearest-unit,global  a subset
//   npm run eval:sweep                              across operating points
//
// stdout is deterministic for a given seed. Timing goes to stderr, because a
// millisecond is not reproducible and pretending otherwise would make the
// determinism check meaningless — see report.ts.

import { writeFileSync } from 'node:fs';
import { buildScenario, SCENARIO_NAMES } from './scenarios/index.js';
import type { ScenarioName, ScenarioOverrides } from './scenarios/index.js';
import { POLICIES, policyByName } from './policies/index.js';
import type { Policy } from './policies/index.js';
import { runScenario } from './runner.js';
import { computeMetrics } from './metrics.js';
import { buildReport, metricsTable } from './report.js';
import type { Row } from './report.js';

const DEFAULT_SEED = 20260901;

type Args = {
  scenarios: ScenarioName[];
  policies: Policy[];
  seed: number;
  sweep: boolean;
  out: string | null;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(key, next);
      i++;
    } else {
      flags.add(key);
    }
  }

  const scenarioArg = values.get('scenario');
  const scenarios = scenarioArg
    ? scenarioArg.split(',').map((name) => asScenarioName(name.trim()))
    : [...SCENARIO_NAMES];

  const policyArg = values.get('policies');
  const policies = policyArg
    ? policyArg.split(',').map((name) => policyByName(name.trim()))
    : [...POLICIES];

  return {
    scenarios,
    policies,
    seed: Number(values.get('seed') ?? DEFAULT_SEED),
    sweep: flags.has('sweep'),
    out: values.get('out') ?? 'EVALUATION.md',
  };
}

function asScenarioName(name: string): ScenarioName {
  if (!(SCENARIO_NAMES as string[]).includes(name)) {
    throw new Error(`unknown scenario "${name}" — known: ${SCENARIO_NAMES.join(', ')}`);
  }
  return name as ScenarioName;
}

async function evaluate(
  scenarios: ScenarioName[],
  policies: Policy[],
  seed: number,
  overrides?: ScenarioOverrides,
): Promise<Row[]> {
  const rows: Row[] = [];

  for (const name of scenarios) {
    for (const policy of policies) {
      // The scenario is rebuilt per policy from the same seed, so every policy
      // faces a byte-identical world — not a world one of them has already
      // moved through.
      const scenario = buildScenario(name, seed, overrides);
      const run = await runScenario(scenario, policy);
      const technicianIds = scenario.snapshot.technicians.map((technician) => technician.id);
      rows.push({ scenario: name, policy: policy.name, metrics: computeMetrics(run, technicianIds) });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// THE SWEEP. One operating point proves nothing about the next: a policy that
// wins at 60 jobs against 24 units may lose at 180, or when the scarce skill
// gets scarcer, or when half the workforce is absent. The sweep re-runs the
// same scenarios across a grid and reports whether the result HOLDS or only
// held where it was first measured.

type SweepPoint = { label: string; overrides: ScenarioOverrides };

const SWEEP_POINTS: SweepPoint[] = [
  { label: 'baseline', overrides: {} },
  { label: 'volume ×2', overrides: { jobCount: 120 } },
  { label: 'volume ×3', overrides: { jobCount: 180 } },
  { label: 'half the technicians', overrides: { fleet: { technicianCount: 15 } } },
  { label: 'half the units', overrides: { fleet: { unitCount: 12 } } },
  {
    label: 'OBD scarce (18 → 4)',
    overrides: { fleet: { scarcity: [{ code: 'OBD_DIAGNOSTICS', holders: 4 }] } },
  },
];

async function runSweep(
  scenarios: ScenarioName[],
  policies: Policy[],
  seed: number,
): Promise<string> {
  const sections: string[] = [];
  const holdsAt: string[] = [];
  const failsAt: string[] = [];

  for (const point of SWEEP_POINTS) {
    const rows = await evaluate(scenarios, policies, seed, point.overrides);
    sections.push(`### ${point.label}`, '', metricsTable(rows), '');

    // Does the project's claim survive at this operating point? The claim is
    // narrow and testable: global resolves at least as many jobs as every
    // greedy baseline, and no baseline beats it on mean resolution while
    // resolving as many.
    const global = rows.filter((row) => row.policy === 'capability-aware-global');
    const beaten = rows.filter((row) => {
      if (row.policy === 'capability-aware-global') return false;
      const rival = global.find((candidate) => candidate.scenario === row.scenario);
      if (!rival) return false;
      if (row.metrics.resolvedCount > rival.metrics.resolvedCount) return true;
      return (
        row.metrics.resolvedCount === rival.metrics.resolvedCount &&
        row.metrics.meanTimeToResolutionMinutes < rival.metrics.meanTimeToResolutionMinutes
      );
    });

    if (beaten.length === 0) {
      holdsAt.push(point.label);
    } else {
      // Name the scenarios it lost, not every (policy, scenario) pair — the
      // pair list runs to a paragraph and buries the one fact that matters.
      const scenariosLost = [...new Set(beaten.map((row) => row.scenario))];
      failsAt.push(`${point.label} (loses ${scenariosLost.join(', ')})`);
    }
  }

  const summary = [
    '**Does the result hold across the sweep?**',
    '',
    'The claim being tested is narrow: `capability-aware-global` resolves at',
    'least as many jobs as every greedy baseline, and none of them beats it on',
    'mean resolution while resolving as many. A point "fails" if any baseline',
    'does either.',
    '',
    holdsAt.length > 0 ? `- Holds at: ${holdsAt.join('; ')}.` : '- Holds at: **no operating point in this sweep.**',
    failsAt.length > 0
      ? `- Fails at: ${failsAt.join('; ')}.`
      : '- Fails at: nowhere.',
    '',
  ];

  return [...summary, ...sections].join('\n');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rows = await evaluate(args.scenarios, args.policies, args.seed);
  const sweep = args.sweep ? await runSweep(args.scenarios, args.policies, args.seed) : undefined;

  const report = buildReport({ rows, seed: args.seed, sweep });

  process.stdout.write(`${report.stdout}\n`);

  if (args.out) {
    writeFileSync(args.out, `${report.document}\n`, 'utf8');
    process.stderr.write(`\nwrote ${args.out}\n`);
  }

  // Not on stdout: a millisecond measurement would break byte-for-byte
  // reproducibility, which is the one property that makes this a measurement.
  process.stderr.write('\nsolver wall clock p95 (not reproducible):\n');
  for (const row of rows) {
    process.stderr.write(
      `  ${row.scenario} / ${row.policy}: ${row.metrics.solverWallClockP95Ms.toFixed(2)} ms\n`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
