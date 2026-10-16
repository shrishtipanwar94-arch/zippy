/**
 * DOES THE DEMO BOARD MAKE THE CHOICE IT WAS BUILT TO MAKE — FOR EVERY FAULT?
 *
 * The demo board (src/demo/demoCrews.ts) has four crews and exactly one right
 * answer for anything the driver can report: crew B. For each fault type in
 * src/demo/faultScenarios.ts this runs the real classifier, the real candidate
 * generator, the real feasibility filter and the real solver against whatever
 * is in the database, prints every crew's verdict, and EXITS NON-ZERO IF THE
 * SOLVER DOES NOT CHOOSE B FOR ANY ONE OF THEM.
 *
 * If it fails, fix the SEED, not the engine: the engine is what the evaluation
 * harness measures, and bending it to suit a demo would make the demo a lie.
 *
 * IT WRITES NOTHING. Each job is built in memory and never inserted: the solver
 * is a pure function over a snapshot (invariant 2).
 *
 *   npx tsx scripts/demo-dry-check.ts
 */

import { config } from '../src/infra/config.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { buildDispatchSnapshot } from '../src/commit/dispatchSnapshot.js';
import { generateCandidates } from '../src/engine/candidates.js';
import type { DispatchOption, DispatchSnapshot, JobForDispatch } from '../src/engine/candidates.js';
import { checkFeasibility } from '../src/engine/feasibility.js';
import { scoreOption } from '../src/engine/cost.js';
import { RECOMMENDED_PLAN, solve } from '../src/engine/solve.js';
import { classifySymptoms } from '../src/domain/faultRules.js';
import { requiredCapabilities, faultsNeedTow } from '../src/domain/capabilitySet.js';
import { DEMO_CREWS, DEMO_DRIVER_LOCATION, DEMO_ZONE } from '../src/demo/demoCrews.js';
import { FAULT_SCENARIOS } from '../src/demo/faultScenarios.js';
import type { FaultScenario } from '../src/demo/faultScenarios.js';

const EXPECTED_WINNER = 'B';

function print(text = ''): void {
  // eslint-disable-next-line no-console
  console.log(text);
}

// "B  DMO-VB" for a demo crew; the bare unit id for anything else, because a
// non-demo unit appearing here means the demo filter is not doing its job.
function crewName(unitId: string): string {
  const crew = DEMO_CREWS.find((candidate) => candidate.unitId === unitId);
  if (!crew) return `?  ${unitId} (NOT A DEMO CREW)`;
  return `${crew.label}  ${crew.unitCode}`;
}

function minutes(option: DispatchOption): string {
  return `${option.estimatedTravelMinutes.toFixed(1).padStart(5)} min`;
}

function jobFor(scenario: FaultScenario, now: Date): JobForDispatch {
  return {
    id: `dry-check-${scenario.fault}`,
    lat: DEMO_DRIVER_LOCATION.lat,
    lng: DEMO_DRIVER_LOCATION.lng,
    faultDistribution: classifySymptoms(scenario.answers),
    createdAt: now,
    // A walk-in: no contract, so no SLA window to miss.
    slaResponseMinutes: null,
    contract: null,
    parkingLevel: null,
    onHighway: false,
    safetyLevel: 'NORMAL',
    vehicleMake: 'MARUTI_SUZUKI',
    vehicleEvClass: null,
  };
}

// One fault: every crew's verdict, then the solver's choice. True when B wins.
async function checkFault(scenario: FaultScenario, snapshot: DispatchSnapshot, now: Date): Promise<boolean> {
  const job = jobFor(scenario, now);
  const required = requiredCapabilities(job.faultDistribution).join('+');
  const tow = faultsNeedTow(job.faultDistribution) ? ', tow' : '';
  print(`${scenario.fault}  (needs ${required}${tow})`);

  const options = await generateCandidates(job, snapshot, undefined, now);
  const { feasible, rejected } = checkFeasibility(options, job, snapshot, now);
  for (const option of feasible) {
    const cost = scoreOption(option, job, now, RECOMMENDED_PLAN).total.toFixed(2);
    print(`    ${crewName(option.unitId)}  FEASIBLE            ${minutes(option)}  cost ${cost}`);
  }
  for (const rejection of rejected) {
    print(`    ${crewName(rejection.option.unitId)}  ${rejection.code.padEnd(19)} ${minutes(rejection.option)}`);
  }

  const outcome = await solve({
    jobs: [job],
    snapshot,
    now,
    jobZone: new Map([[job.id, DEMO_ZONE.id]]),
    zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
  });
  const plan = outcome.plans.find((candidate) => candidate.label === RECOMMENDED_PLAN);
  const chosen = plan?.assignments.find((assignment) => assignment.jobId === job.id);
  const expected = DEMO_CREWS.find((crew) => crew.label === EXPECTED_WINNER);
  const correct = chosen !== undefined && chosen.unitId === expected?.unitId;
  print(`    -> solver chooses ${chosen ? crewName(chosen.unitId) : 'NOBODY'}  ${correct ? 'PASS' : 'FAIL'}`);
  return correct;
}

async function main(): Promise<void> {
  const now = new Date();
  const { snapshot } = await buildDispatchSnapshot(prismaBase);
  if (!snapshot.zones.some((zone) => zone.id === DEMO_ZONE.id)) {
    throw new Error('no demo zone on the board — run `npm run db:seed:demo` first');
  }

  print(`routing ${config.routingMode} · demo mode ${config.demoMode ? 'on' : 'OFF'} · ${snapshot.units.length} units on the board`);
  print('-'.repeat(76));

  const failed: string[] = [];
  for (const scenario of FAULT_SCENARIOS) {
    const passed = await checkFault(scenario, snapshot, now);
    if (!passed) failed.push(scenario.fault);
  }

  print('-'.repeat(76));
  if (failed.length === 0) {
    print(`PASS — crew ${EXPECTED_WINNER} wins all ${FAULT_SCENARIOS.length} fault types.`);
  } else {
    print(`FAIL — crew ${EXPECTED_WINNER} did not win: ${failed.join(', ')}. Fix the SEED, not the engine.`);
  }

  // exitCode, not process.exit(): on Windows, exiting while Prisma's engine
  // is still closing its handles aborts Node with a libuv assertion and exit
  // code 127 — which made a PASS indistinguishable from a crash.
  process.exitCode = failed.length === 0 ? 0 : 1;
  await prismaBase.$disconnect();
}

main().catch(async (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
  await prismaBase.$disconnect();
});
