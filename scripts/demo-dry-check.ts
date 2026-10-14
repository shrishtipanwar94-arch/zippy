/**
 * IS THE DEMO BOARD ACTUALLY DISPATCHABLE? Answered before anybody opens a
 * browser.
 *
 * The failure this exists to catch is the one that wastes a demo: every screen
 * looks right, the driver reports a breakdown, and the solver quietly returns
 * nothing because the one van on the board fails one of the ten feasibility
 * filters. Reading the seed does not tell you that — the capability requirement
 * is computed from a probability DISTRIBUTION, not from a fault code, so
 * whether `JUMP_START` is enough depends on arithmetic rather than on
 * intention.
 *
 * So this runs the real classifier, the real candidate generator and the real
 * feasibility filter against whatever is in the database right now, and prints
 * the verdict per option with its reason code.
 *
 * IT WRITES NOTHING. The job is built in memory and never inserted: the solver
 * is a pure function over a snapshot (invariant 2), so a dry run needs no row.
 * That also means it is safe to run against a board mid-demo.
 *
 *   npx tsx scripts/demo-dry-check.ts
 */

import { prismaBase } from '../src/infra/prismaBase.js';
import { buildDispatchSnapshot } from '../src/commit/dispatchSnapshot.js';
import { generateCandidates } from '../src/engine/candidates.js';
import type { JobForDispatch } from '../src/engine/candidates.js';
import { checkFeasibility } from '../src/engine/feasibility.js';
import { classifySymptoms } from '../src/domain/faultRules.js';
import { contendingFaults, requiredCapabilities, faultsNeedTow } from '../src/domain/capabilitySet.js';
import { rankFaults } from '../src/domain/entropy.js';
import type { SymptomPayload } from '../src/domain/symptoms.js';

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

function line(): void {
  // eslint-disable-next-line no-console
  console.log('-'.repeat(72));
}

async function main(): Promise<void> {
  const now = new Date();

  // --- what intake would believe, from those answers --------------------
  const distribution = classifySymptoms(FLAT_BATTERY_ANSWERS);
  const contenders = contendingFaults(distribution);
  const required = requiredCapabilities(distribution);
  const needsTow = faultsNeedTow(distribution);

  line();
  // eslint-disable-next-line no-console
  console.log('DIAGNOSIS from the demo answers (WONT_START / cranks NO / BATTERY light)');
  line();
  for (const fault of rankFaults(distribution).slice(0, 5)) {
    const share = (distribution[fault] * 100).toFixed(1).padStart(5);
    // eslint-disable-next-line no-console
    console.log(`  ${share}%  ${fault}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n  contending faults (to 80% mass): ${contenders.join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  required capabilities:           ${required.join(', ')}`);
  // eslint-disable-next-line no-console
  console.log(`  needs a tow (so a workshop):     ${needsTow ? 'YES' : 'no'}`);

  // --- what is on the board ---------------------------------------------
  // `buildDispatchSnapshot` returns the pending jobs alongside the snapshot;
  // this check supplies its own in-memory job, so only the snapshot is used.
  const { snapshot, jobs: pending } = await buildDispatchSnapshot(prismaBase);

  line();
  // eslint-disable-next-line no-console
  console.log('THE BOARD');
  line();
  // eslint-disable-next-line no-console
  console.log(
    `  ${snapshot.units.length} units, ${snapshot.technicians.length} technicians, ` +
      `${snapshot.shifts.length} shifts, ${snapshot.zones.length} zones, ` +
      `${pending.length} jobs already waiting`,
  );
  for (const unit of snapshot.units) {
    const technician = snapshot.technicians.find((candidate) => candidate.id === unit.currentTechnicianId);
    const covering = snapshot.shifts.filter(
      (shift) =>
        shift.technicianId === unit.currentTechnicianId && shift.startsAt <= now && shift.endsAt >= now,
    );
    // eslint-disable-next-line no-console
    console.log(
      `  unit ${unit.id} (${unit.kind}, ${unit.status}) crew=${technician?.id ?? 'NONE'} ` +
        `onShiftNow=${covering.length > 0 ? 'yes' : 'NO'}\n` +
        `       unit can do: ${unit.capabilityCodes.join(', ') || '(none)'}\n` +
        `       crew can do: ${technician?.capabilityCodes.join(', ') || '(none)'}`,
    );
  }

  if (snapshot.zones.length === 0) {
    throw new Error('no zones on the board — run `npm run db:seed:demo` first');
  }

  // --- the sample job, in memory only -----------------------------------
  const zone = snapshot.zones[0]!;
  const job: JobForDispatch = {
    id: 'dry-check-sample-job',
    // A few hundred metres off the zone centroid, so this is a real routing
    // question rather than a zero-distance one.
    lat: zone.centroidLat + 0.004,
    lng: zone.centroidLng + 0.004,
    faultDistribution: distribution,
    createdAt: now,
    // No contract behind a walk-in, so there is no SLA window to miss.
    slaResponseMinutes: null,
    contract: null,
    // Street level: a basement would exclude some unit kinds (ACCESS_RESTRICTION).
    parkingLevel: 'STREET',
    onHighway: false,
    safetyLevel: 'NORMAL',
    vehicleMake: 'MARUTI_SUZUKI',
    vehicleEvClass: null,
  };

  const options = await generateCandidates(job, snapshot, undefined, now);
  const result = checkFeasibility(options, job, snapshot, now);

  line();
  // eslint-disable-next-line no-console
  console.log('FEASIBILITY');
  line();
  // eslint-disable-next-line no-console
  console.log(`  ${options.length} options generated, ${result.feasible.length} feasible, ${result.rejected.length} rejected\n`);

  for (const option of result.feasible) {
    // eslint-disable-next-line no-console
    console.log(
      `  FEASIBLE  unit=${option.unitId} crew=${option.technicianId} ` +
        `travel=${option.estimatedTravelMinutes.toFixed(1)}min ` +
        `covers=${(option.coveredFaultProbability * 100).toFixed(0)}% ` +
        `degraded=${option.travelEstimateDegraded}`,
    );
  }
  for (const rejection of result.rejected) {
    // eslint-disable-next-line no-console
    console.log(
      `  REJECTED  unit=${rejection.option.unitId} crew=${rejection.option.technicianId}\n` +
        `            ${rejection.code}: ${rejection.detail}`,
    );
  }

  line();
  const verdict =
    result.feasible.length > 0
      ? 'READY — at least one crew can take this job. The demo will dispatch.'
      : 'NOT READY — every option was rejected. Fix the SEED (reason codes above), not the engine.';
  // eslint-disable-next-line no-console
  console.log(verdict);
  line();

  await prismaBase.$disconnect();
  process.exit(result.feasible.length > 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await prismaBase.$disconnect();
  process.exit(1);
});
