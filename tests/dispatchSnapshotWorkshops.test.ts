// PHASE 22, end to end: src/commit/dispatchSnapshot.ts reads real workshop
// rows, real authorisation and hours, and real AcceptanceOutcome counts into
// the shape src/engine/destinationSelection.ts expects — and a real solve
// over a tow-needing job actually resolves a destination from them.
//
// SCOPED TO THIS FILE'S OWN VEHICLE MAKE. `buildDispatchSnapshot` reads the
// WHOLE fleet and the whole workshop network — the same gotcha
// tests/stock.test.ts already documents for units applies here: a fixture
// vehicle whose make no seeded workshop recognises is what keeps this file's
// job from accidentally being served by a workshop it did not build, and
// what keeps this file's own workshop from being a candidate for anyone
// else's job.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { buildDispatchSnapshot } from '../src/commit/dispatchSnapshot.js';
import { solve } from '../src/engine/solve.js';

const PREFIX = 'dsws';
const MAKE = 'DSWS_MOTORS';
const NOW = new Date('2026-06-15T10:00:00Z'); // Monday, 15:30 IST

beforeAll(async () => {
  await buildFixture();
}, 60_000);

afterAll(async () => {
  await prismaBase.$disconnect().catch(() => undefined);
});

describe('buildDispatchSnapshot reads the workshop network', () => {
  it('carries this fixture’s workshop, its authorisation and its hours', async () => {
    const { snapshot } = await buildDispatchSnapshot(prismaBase, { now: NOW });
    const workshop = snapshot.workshops?.workshops.find((w) => w.id === `${PREFIX}-workshop`);

    expect(workshop).toBeDefined();
    expect(workshop?.authorisedBrands).toContain(MAKE);
    expect(workshop?.hours).toHaveLength(7);
  });

  it('folds this fixture’s AcceptanceOutcome rows into counts by (workshop, bucket, class)', async () => {
    const { snapshot } = await buildDispatchSnapshot(prismaBase, { now: NOW });
    const cell = snapshot.workshops?.acceptance.find(
      (c) => c.workshopId === `${PREFIX}-workshop` && c.hourBucket === 'MORNING' && c.vehicleClass === 'NONE',
    );

    expect(cell).toBeDefined();
    expect(cell?.accepted).toBeGreaterThanOrEqual(3);
    expect(cell?.refused).toBe(0);
  });

  it('reads the job’s vehicle make and EV class onto JobForDispatch', async () => {
    const { jobs } = await buildDispatchSnapshot(prismaBase, { jobIds: [`${PREFIX}-job`] });
    const job = jobs.find((candidate) => candidate.id === `${PREFIX}-job`);

    expect(job?.vehicleMake).toBe(MAKE);
    expect(job?.vehicleEvClass).toBeNull();
  });
});

describe('a real solve resolves a real destination for a tow job', () => {
  it('chooses this fixture’s own workshop, and the option is feasible', async () => {
    const { jobs, snapshot, jobZone } = await buildDispatchSnapshot(prismaBase, {
      jobIds: [`${PREFIX}-job`],
    });

    const outcome = await solve({
      jobs,
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: 1_000_000,
    });

    const balanced = outcome.plans.find((plan) => plan.label === 'BALANCED')!;
    const assignment = balanced.assignments.find((candidate) => candidate.jobId === `${PREFIX}-job`);

    expect(assignment).toBeDefined();
    expect(assignment?.option.destination.status).toBe('CHOSEN');
    expect(assignment?.option.destination.workshopId).toBe(`${PREFIX}-workshop`);
    // The refusal-risk term is finite and non-negative — a real P(accept),
    // not the neutral 1 a NOT_NEEDED/NOT_MODELLED job would carry.
    expect(assignment?.option.destination.pAccept).toBeGreaterThan(0);
    expect(assignment?.option.destination.pAccept).toBeLessThanOrEqual(1);
  });

  it('rejects with DESTINATION_NOT_AUTHORISED for a brand nothing in the fleet services', async () => {
    const { jobs, snapshot, jobZone } = await buildDispatchSnapshot(prismaBase, {
      jobIds: [`${PREFIX}-unauthorised-job`],
    });

    const outcome = await solve({
      jobs,
      snapshot,
      now: NOW,
      jobZone,
      zonePartitionThreshold: 1_000_000,
    });

    // Filtered to THIS fixture's own tow-capable unit — buildDispatchSnapshot
    // reads the whole seeded fleet, so most rejections for this job are
    // VEHICLE_TYPE_INCOMPATIBLE from ordinary vans that were never in the
    // running. The one unit actually equipped to tow is rejected on
    // destination authorisation instead, which is the fact under test.
    const rejection = outcome.rejected.find(
      (candidate) => candidate.jobId === `${PREFIX}-unauthorised-job` && candidate.option.unitId === `${PREFIX}-unit`,
    );
    expect(rejection?.code).toBe('DESTINATION_NOT_AUTHORISED');
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'DSW',
      name: 'Dispatch Snapshot Workshops Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });

  await prismaBase.workshop.upsert({
    where: { id: `${PREFIX}-workshop` },
    update: {},
    create: {
      id: `${PREFIX}-workshop`,
      code: `${PREFIX}-WS`,
      name: 'Dispatch Snapshot Workshops Fixture Workshop',
      zoneId: `${PREFIX}-zone`,
      lat: 28.6152,
      lng: 77.2095,
      active: true,
      authorisations: { create: { id: `${PREFIX}-wsauth`, brand: MAKE, level: 'STANDARD' } },
      hours: {
        create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          id: `${PREFIX}-wshours-${dayOfWeek}`,
          dayOfWeek,
          opens: '00:00',
          closes: '24:00',
          closed: false,
        })),
      },
    },
  });

  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: MAKE,
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  // A SECOND profile whose make nothing is authorised for — the
  // DESTINATION_NOT_AUTHORISED test's own vehicle.
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-unauthorised-profile` },
    update: {},
    create: {
      id: `${PREFIX}-unauthorised-profile`,
      make: `${MAKE}_UNAUTHORISED`,
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-driver-user`,
      email: `${PREFIX}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Fixture Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-driver-user`, homeZoneId: `${PREFIX}-zone` },
  });

  for (const [vehicleId, profileId, registration] of [
    [`${PREFIX}-vehicle`, `${PREFIX}-profile`, 'DSWS0001'],
    [`${PREFIX}-unauthorised-vehicle`, `${PREFIX}-unauthorised-profile`, 'DSWS0002'],
  ] as const) {
    await prismaBase.vehicle.upsert({
      where: { id: vehicleId },
      update: {},
      create: { id: vehicleId, driverId: `${PREFIX}-driver`, profileId, registration, colour: 'White' },
    });
  }

  // A dedicated, terminal history job — real acceptance history has to hang
  // off a real Job row, and this one exists for nothing else. RESOLVED so it
  // can never be a candidate in anyone's solve.
  await prismaBase.job.upsert({
    where: { id: `${PREFIX}-history-job` },
    update: {},
    create: {
      id: `${PREFIX}-history-job`,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'RESOLVED',
      lat: 28.6152,
      lng: 77.2095,
    },
  });

  // Three real ACCEPTED outcomes in the MORNING bucket, for the exact cell
  // the second test reads back.
  for (let i = 0; i < 3; i += 1) {
    const id = `${PREFIX}-offer-${i}`;
    const at = new Date('2026-06-10T04:00:00Z'); // 09:30 IST, a real MORNING moment
    await prismaBase.destinationOffer.upsert({
      where: { id },
      update: {},
      create: {
        id,
        jobId: `${PREFIX}-history-job`,
        workshopId: `${PREFIX}-workshop`,
        status: 'ACCEPTED',
        sentAt: at,
        expiresAt: new Date(at.getTime() + 5 * 60_000),
        respondedAt: at,
      },
    });
    await prismaBase.acceptanceOutcome.upsert({
      where: { destinationOfferId: id },
      update: {},
      create: {
        destinationOfferId: id,
        workshopId: `${PREFIX}-workshop`,
        outcome: 'ACCEPTED',
        hourBucket: 'MORNING',
        vehicleClass: 'NONE',
        recordedAt: at,
      },
    });
  }

  // The unit + technician a tow needs — FLATBED_LOADING, on a FLATBED_TOW.
  for (const code of ['FLATBED_LOADING', 'WINCH_RECOVERY']) {
    await prismaBase.capability.upsert({
      where: { code },
      update: {},
      create: { code, name: code, category: 'TEST', description: 'test fixture capability' },
    });
  }
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user`,
      email: `${PREFIX}-tech@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: 'Fixture Technician',
    },
  });
  await prismaBase.technician.upsert({
    where: { id: `${PREFIX}-tech` },
    update: { active: true },
    create: {
      id: `${PREFIX}-tech`,
      userId: `${PREFIX}-tech-user`,
      employeeCode: `${PREFIX}-T1`,
      homeZoneId: `${PREFIX}-zone`,
      capabilities: {
        create: [
          { id: `${PREFIX}-cap-flatbed`, capability: { connect: { code: 'FLATBED_LOADING' } } },
          { id: `${PREFIX}-cap-winch`, capability: { connect: { code: 'WINCH_RECOVERY' } } },
        ],
      },
    },
  });
  await prismaBase.unit.upsert({
    where: { id: `${PREFIX}-unit` },
    update: { currentTechnicianId: `${PREFIX}-tech`, status: 'AVAILABLE' },
    create: {
      id: `${PREFIX}-unit`,
      code: `${PREFIX}-UNIT`,
      kind: 'FLATBED_TOW',
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      currentTechnicianId: `${PREFIX}-tech`,
      lat: 28.6152,
      lng: 77.2095,
      capabilities: {
        create: [
          { id: `${PREFIX}-unitcap-flatbed`, capability: { connect: { code: 'FLATBED_LOADING' } } },
          { id: `${PREFIX}-unitcap-winch`, capability: { connect: { code: 'WINCH_RECOVERY' } } },
        ],
      },
    },
  });
  await prismaBase.technicianShift.upsert({
    where: { id: `${PREFIX}-shift` },
    update: {
      startsAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000),
      endsAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    },
    create: {
      id: `${PREFIX}-shift`,
      technicianId: `${PREFIX}-tech`,
      zoneId: `${PREFIX}-zone`,
      startsAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1000),
      endsAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    },
  });

  // Two jobs: one whose vehicle's make this fixture's workshop is authorised
  // for, one whose make nothing in the fleet is authorised for.
  for (const [jobId, vehicleId] of [
    [`${PREFIX}-job`, `${PREFIX}-vehicle`],
    [`${PREFIX}-unauthorised-job`, `${PREFIX}-unauthorised-vehicle`],
  ] as const) {
    await prismaBase.job.upsert({
      where: { id: jobId },
      update: { status: 'INTAKE', assignedUnitId: null },
      create: {
        id: jobId,
        driverId: `${PREFIX}-driver`,
        vehicleId,
        zoneId: `${PREFIX}-zone`,
        status: 'INTAKE',
        safetyLevel: 'NORMAL',
        lat: 28.6152,
        lng: 77.2095,
      },
    });
    await prismaBase.faultHypothesis.upsert({
      where: { id: `${jobId}-hypothesis` },
      update: {},
      create: {
        id: `${jobId}-hypothesis`,
        jobId,
        version: 0,
        // A tow-needing distribution — IMMOBILISED_UNKNOWN requires
        // FLATBED_LOADING, exactly the capability this fixture's unit holds.
        distribution: { IMMOBILISED_UNKNOWN: 1 },
        requiredCapabilityCodes: ['FLATBED_LOADING'],
        entropy: 0,
        topFault: 'IMMOBILISED_UNKNOWN',
      },
    });
  }
}
