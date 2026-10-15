// WHAT A REQUEUED JOB SAYS, AND WHO CAN SEE IT.
//
// A saga whose first leg loses its race ends REQUEUED, and
// `finishAsRequeued` (src/commit/saga.ts) parks the job at PLANNED with no
// unit and no technician on the row. `releaseCurrentCrew`
// (src/commit/redispatch.ts) leaves exactly the same shape when a diagnosis
// change takes the assigned crew off a job. In both cases nothing is held,
// nothing is in flight, and nothing will move until a dispatcher acts.
//
// Two things have to be true in that state and this file pins both:
//
//   1. THE DRIVER IS NOT TOLD A CREW IS COMING. `headlineFor` keyed only on
//      the status, so a crewless PLANNED job read "We have found a crew for
//      this and are contacting them now" — the opposite of the truth, on the
//      one screen whose reader is already having a bad day.
//   2. THE DISPATCHER CAN SEE IT (invariant 8). A requeued job must appear on
//      the board while it is still INSIDE its SLA window, not only once the
//      window closes and `ESCALATE_SLA_WINDOW_CLOSED` raises a card. A
//      degraded state that is only visible after it has become a breach is
//      not visible to an operator in any useful sense.
//
// NO UNIT OR DISPATCH_OFFER FIXTURE HERE, deliberately. GET /queue filters on
// the job row alone (`status in (INTAKE, PLANNED)` and `assignedUnitId: null`,
// see src/api/console.ts), so a REQUEUED `dispatch_offers` row would add two
// crew fixtures and prove nothing the job row does not already prove. The job
// below is written in the exact shape saga.ts:443 leaves behind.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { startSaga } from '../src/commit/saga.js';
import { headlineFor } from '../src/domain/driverNarrative.js';
import { needsDecision } from '../src/domain/actionTiers.js';

// Every row this file writes carries this prefix, so its assertions can be
// scoped to rows that cannot exist unless this file created them — `zippy_test`
// is shared and vitest runs files in parallel.
const PREFIX = 'requeue';
const TENANT = `${PREFIX}-tenant`;
const TECH = `${PREFIX}-tech`;

// ONE SET OF IDS PER RUN, because these rows cannot be deleted afterwards: a
// database trigger makes `job_events` append-only, and the saga under test
// writes two of them, so `jobs.deleteMany` is refused outright. Reusing a fixed
// id would mean the second run deleting rows it is not allowed to delete. The
// previous run's jobs are aged out in `buildFixture` instead.
const RUN = Date.now();
const JOB = `${PREFIX}-job-${RUN}`;
const UNIT = `${PREFIX}-unit-${RUN}`;

// Two minutes ago, against a sixty-minute response window: comfortably inside
// the SLA window, and in the PAST so this fixture never outranks a real job on
// a "newest N" list.
const RESPONSE_MINUTES = 60;
const JOB_AGE_MINUTES = 2;

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('headlineFor — a PLANNED job with nobody on it', () => {
  // THE BUG, STATED AS THE DRIVER WOULD STATE IT.
  it('does not tell the driver a crew has been found', () => {
    const headline = headlineFor({
      status: 'PLANNED',
      // The whole point: a requeue leaves no technician on the row, and
      // `helperName` is already documented as null before anyone is assigned.
      helperName: null,
      arrivingAt: null,
      replanning: false,
      sourcingPart: false,
      intakeComplete: true,
    });

    expect(headline).not.toContain('found a crew');
    expect(headline).not.toContain('contacting them');
  });

  it('says it is still looking for a crew', () => {
    const headline = headlineFor({
      status: 'PLANNED',
      helperName: null,
      arrivingAt: null,
      replanning: false,
      sourcingPart: false,
      intakeComplete: true,
    });

    expect(headline.toLowerCase()).toContain('looking');
  });

  // THE OTHER HALF OF THE BRANCH. Phase 22b split PLANNED from OFFERED on
  // purpose — "the solver picked a crew, nobody has been asked yet" is real
  // news and worth its own sentence. Keyed on the crew rather than the status,
  // that sentence survives for any path that does put a crew on a PLANNED row.
  it('still announces the crew when one is actually on the job', () => {
    const headline = headlineFor({
      status: 'PLANNED',
      helperName: 'Anil',
      arrivingAt: null,
      replanning: false,
      sourcingPart: false,
      intakeComplete: true,
    });

    expect(headline).toContain('found a crew');
  });

  // A re-plan already has its own louder sentence and must keep winning: a
  // driver whose crew was taken off the job needs that news, not this one.
  it('is still outranked by an in-flight re-plan', () => {
    const headline = headlineFor({
      status: 'PLANNED',
      helperName: null,
      arrivingAt: null,
      replanning: true,
      sourcingPart: false,
      intakeComplete: true,
    });

    expect(headline.toLowerCase()).not.toContain('looking');
  });
});

describe('a requeued saga, inside the SLA window — invariant 8', () => {
  // THE REAL PATH, NOT A HAND-WRITTEN ROW. A stale `expectedUnitVersion` makes
  // leg 1's conditional update affect zero rows, which is exactly how a
  // dispatcher who lost the race reaches `finishAsRequeued`.
  it('raises an operator card naming the job, before any SLA breach', async () => {
    const outcome = await startSaga(prismaBase, {
      jobId: JOB,
      unitId: UNIT,
      technicianId: TECH,
      // The unit is at version 0. Anything else loses.
      expectedUnitVersion: 999,
    });
    expect(outcome.outcome).toBe('REQUEUED');

    // The state the driver and the dispatcher are both looking at: planned,
    // nobody on it.
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: JOB },
      select: { status: true, assignedUnitId: true, assignedTechnicianId: true, createdAt: true },
    });
    expect(job.status).toBe('PLANNED');
    expect(job.assignedUnitId).toBeNull();
    expect(job.assignedTechnicianId).toBeNull();

    // STILL INSIDE THE WINDOW, asserted rather than assumed — the claim is that
    // visibility does not wait for the promise to be broken.
    const ageMinutes = (Date.now() - job.createdAt.getTime()) / 60_000;
    expect(ageMinutes).toBeLessThan(RESPONSE_MINUTES);

    // SCOPED TO THIS FILE'S OWN JOB. `zippy_test` is shared and carries
    // thousands of pending jobs from every earlier run, so anything phrased
    // about a global list — "my job is in the top fifty of GET /queue" — is an
    // assertion about the whole database and drifts the moment another suite
    // writes. A card that cannot exist unless this requeue created it is the
    // stronger claim anyway.
    const cards = await prismaBase.actionRequest.findMany({
      where: { jobId: JOB, status: 'PENDING' },
      select: { kind: true, tier: true, reason: true },
    });

    const requeued = cards.find((card) => card.kind === 'ESCALATE_DISPATCH_REQUEUED');
    expect(requeued).toBeDefined();
    expect(requeued?.tier).toBe('RECOMMEND');
    expect(requeued?.reason).toContain('did not hold');

    // And the visibility is NOT coming from the breach path.
    expect(cards.some((card) => card.kind === 'ESCALATE_SLA_WINDOW_CLOSED')).toBe(false);
  });

  // The dispatcher's worklist sorts on "does acting on this change whether
  // anybody is going?" — and for a requeued job nobody is.
  it('sorts with the cards that change whether anybody is going', () => {
    expect(needsDecision('ESCALATE_DISPATCH_REQUEUED')).toBe(true);
  });

  it('raises one card however many times the reservation loses', async () => {
    await startSaga(prismaBase, {
      jobId: JOB,
      unitId: UNIT,
      technicianId: TECH,
      expectedUnitVersion: 998,
    });

    const count = await prismaBase.actionRequest.count({
      where: { jobId: JOB, kind: 'ESCALATE_DISPATCH_REQUEUED', status: 'PENDING' },
    });
    expect(count).toBe(1);
  });
});

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Requeue Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'RQZ',
      name: 'Requeue Zone',
      city: 'Delhi',
      centroidLat: 28.6152,
      centroidLng: 77.2095,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'TEST_REQUEUE',
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
      email: 'requeue-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Requeue Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: {
      id: `${PREFIX}-driver`,
      userId: `${PREFIX}-driver-user`,
      tenantId: TENANT,
      homeZoneId: `${PREFIX}-zone`,
    },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'RQ00001',
      colour: 'White',
    },
  });

  // A CONTRACT ONLY SO THE JOB HAS A WINDOW TO BE INSIDE OF. The claim under
  // test is about a job whose response window has NOT closed, which needs a
  // real `responseMinutes` to be measured against.
  await prismaBase.contractTier.upsert({
    where: { id: `${PREFIX}-tier` },
    update: {},
    create: {
      id: `${PREFIX}-tier`,
      name: 'GOLD',
      description: 'Requeue fixture tier',
      priority: 10,
    },
  });
  await prismaBase.contract.upsert({
    where: { id: `${PREFIX}-contract` },
    update: {},
    create: {
      id: `${PREFIX}-contract`,
      tenantId: TENANT,
      tierId: `${PREFIX}-tier`,
      name: 'Requeue Contract',
      startsAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  await prismaBase.slaPolicy.upsert({
    where: { id: `${PREFIX}-sla` },
    update: {},
    create: {
      id: `${PREFIX}-sla`,
      contractId: `${PREFIX}-contract`,
      serviceType: 'BREAKDOWN',
      responseMinutes: RESPONSE_MINUTES,
      resolutionMinutes: 240,
      breachPenaltyPaise: 100_000,
    },
  });

  // THE CREW THE SAGA WILL FAIL TO RESERVE. No capabilities attached: this
  // file never runs a solve, so nothing here reads one.
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user`,
      email: 'requeue-tech@example.test',
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: 'Requeue Tech',
    },
  });
  await prismaBase.technician.upsert({
    where: { id: TECH },
    update: {},
    create: {
      id: TECH,
      userId: `${PREFIX}-tech-user`,
      employeeCode: 'RQ-T1',
      homeZoneId: `${PREFIX}-zone`,
    },
  });

  // New each run, so it starts AVAILABLE at version 0 — the saga below depends
  // on knowing the version it passes is stale. It carries no capabilities, so
  // no other suite's solve can ever pick it.
  await prismaBase.unit.create({
    data: {
      id: UNIT,
      code: `RQ-${RUN}`,
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      lat: 28.6152,
      lng: 77.2095,
    },
  });

  // AGE OUT EVERY EARLIER RUN'S JOB. They cannot be deleted, so they are
  // retired to a finished status instead: left PLANNED they would pile up as
  // permanent crewless jobs on a shared board, which is the shape this very
  // file exists to complain about.
  await prismaBase.job.updateMany({
    where: { tenantId: TENANT, id: { not: JOB }, status: { notIn: ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] } },
    data: { status: 'CANCELLED' },
  });

  // THE SHAPE A REQUEUE LEAVES BEHIND: PLANNED, no unit, no technician.
  await prismaBase.job.create({
    data: {
      id: JOB,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      slaPolicyId: `${PREFIX}-sla`,
      status: 'PLANNED',
      safetyLevel: 'NORMAL',
      assignedUnitId: null,
      assignedTechnicianId: null,
      createdAt: new Date(Date.now() - JOB_AGE_MINUTES * 60_000),
      lat: 28.6152,
      lng: 77.2095,
    },
  });
}
