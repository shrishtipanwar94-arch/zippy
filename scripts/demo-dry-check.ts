/**
 * DOES THE DEMO BOARD MAKE THE CHOICE IT WAS BUILT TO MAKE? Answered before
 * anybody opens a browser.
 *
 * The demo board (src/demo/demoCrews.ts) has four crews, each wrong in a
 * different way, and exactly one right answer for a flat battery: crew B. This
 * runs the real classifier, the real candidate generator, the real feasibility
 * filter and the real solver against whatever is in the database, prints every
 * crew's verdict, and EXITS NON-ZERO IF THE SOLVER DOES NOT CHOOSE B.
 *
 * If it fails, fix the SEED, not the engine: the engine is what the evaluation
 * harness measures, and bending it to suit a demo would make the demo a lie.
 *
 * IT WRITES NOTHING. The job is built in memory and never inserted: the solver
 * is a pure function over a snapshot (invariant 2), so a dry run needs no row
 * and is safe to run against a live board.
 *
 *   npx tsx scripts/demo-dry-check.ts
 */

import { config } from '../src/infra/config.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { buildDispatchSnapshot } from '../src/commit/dispatchSnapshot.js';
import { generateCandidates } from '../src/engine/candidates.js';
import type { DispatchOption, JobForDispatch } from '../src/engine/candidates.js';
import { checkFeasibility } from '../src/engine/feasibility.js';
import { scoreOption } from '../src/engine/cost.js';
import { RECOMMENDED_PLAN, solve } from '../src/engine/solve.js';
import { classifySymptoms } from '../src/domain/faultRules.js';
import { contendingFaults, requiredCapabilities, faultsNeedTow } from '../src/domain/capabilitySet.js';
import type { SymptomPayload } from '../src/domain/symptoms.js';
import { DEMO_CREWS, DEMO_DRIVER_LOCATION, DEMO_ZONE } from '../src/demo/demoCrews.js';

// THE ANSWERS THE DEMO SCRIPT TELLS THE DRIVER TO GIVE. Kept identical to
// DEMO.md on purpose — if the two drift, this check stops describing the demo
// somebody is about to run.
const FLAT_BATTERY_ANSWERS: SymptomPayload = {
  primaryComplaint: 'WONT_START',
  engineCranks: 'NO',
  warningLights: ['BATTERY'],
  unusualSound: null,
  vehicleMoves: null,
};

const EXPECTED_WINNER = 'B';

function print(text = ''): void {
  // eslint-disable-next-line no-console
  console.log(text);
}

function rule(): void {
  print('-'.repeat(76));
}

// "B  DMO-VB Ravi Kumar" for a demo crew; the bare unit id for anything else,
// because on a shared database the main seed's fleet is a candidate too.
function crewName(unitId: string): string {
  const crew = DEMO_CREWS.find((candidate) => candidate.unitId === unitId);
  if (!crew) return `-  ${unitId} (not a demo crew)`;
  return `${crew.label}  ${crew.unitCode} ${crew.name}`;
}

function travel(option: DispatchOption): string {
  const how = option.travelEstimateDegraded ? 'haversine' : 'road';
  return `${option.estimatedTravelMinutes.toFixed(1)} min ${how}`;
}

async function main(): Promise<void> {
  const now = new Date();
  const distribution = classifySymptoms(FLAT_BATTERY_ANSWERS);

  rule();
  print('THE JOB: a flat battery at the driver form\'s default location');
  rule();
  print(`  contending faults:      ${contendingFaults(distribution).join(', ')}`);
  print(`  required capabilities:  ${requiredCapabilities(distribution).join(', ')}`);
  print(`  needs a tow:            ${faultsNeedTow(distribution) ? 'YES' : 'no'}`);
  print(`  routing mode:           ${config.routingMode}`);

  const { snapshot } = await buildDispatchSnapshot(prismaBase);
  const zone = snapshot.zones.find((candidate) => candidate.id === DEMO_ZONE.id);
  if (!zone) throw new Error('no demo zone on the board — run `npm run db:seed:demo` first');

  const job: JobForDispatch = {
    id: 'dry-check-flat-battery',
    lat: DEMO_DRIVER_LOCATION.lat,
    lng: DEMO_DRIVER_LOCATION.lng,
    faultDistribution: distribution,
    createdAt: now,
    // A walk-in: no contract, so no SLA window to miss.
    slaResponseMinutes: null,
    contract: null,
    parkingLevel: 'STREET',
    onHighway: false,
    safetyLevel: 'NORMAL',
    vehicleMake: 'MARUTI_SUZUKI',
    vehicleEvClass: null,
  };

  // --- every crew's verdict ---------------------------------------------
  const options = await generateCandidates(job, snapshot, undefined, now);
  const { feasible, rejected } = checkFeasibility(options, job, snapshot, now);

  rule();
  print(`EVERY CREW (${options.length} options: ${feasible.length} feasible, ${rejected.length} rejected)`);
  rule();
  for (const option of feasible) {
    const cost = scoreOption(option, job, now, RECOMMENDED_PLAN);
    print(`  ${crewName(option.unitId)}`);
    print(`     FEASIBLE   ${travel(option)}, ${RECOMMENDED_PLAN} cost ${cost.total.toFixed(2)}`);
  }
  for (const rejection of rejected) {
    print(`  ${crewName(rejection.option.unitId)}`);
    print(`     ${rejection.code}   ${travel(rejection.option)} — ${rejection.detail}`);
  }

  // --- the solver's choice ----------------------------------------------
  const outcome = await solve({
    jobs: [job],
    snapshot,
    now,
    jobZone: new Map([[job.id, zone.id]]),
    zonePartitionThreshold: config.SOLVER_ZONE_PARTITION_THRESHOLD,
  });
  const plan = outcome.plans.find((candidate) => candidate.label === RECOMMENDED_PLAN);
  const chosen = plan?.assignments.find((assignment) => assignment.jobId === job.id);
  const expected = DEMO_CREWS.find((crew) => crew.label === EXPECTED_WINNER);

  rule();
  print(`THE SOLVER CHOOSES (${RECOMMENDED_PLAN} plan): ${chosen ? crewName(chosen.unitId) : 'NOBODY'}`);
  rule();

  const correct = chosen !== undefined && chosen.unitId === expected?.unitId;
  if (correct) {
    print(`PASS — crew ${EXPECTED_WINNER} wins, as the demo board was built to show.`);
  } else {
    print(`FAIL — expected crew ${EXPECTED_WINNER}. Fix the SEED (src/demo/demoCrews.ts), not the engine.`);
  }
  rule();

  // exitCode, not process.exit(): on Windows, exiting while Prisma's engine
  // is still closing its handles aborts Node with a libuv assertion and exit
  // code 127 — which made a PASS indistinguishable from a crash.
  process.exitCode = correct ? 0 : 1;
  await prismaBase.$disconnect();
}

main().catch(async (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
  await prismaBase.$disconnect();
});
