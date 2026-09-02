// RE-DISPATCH, END TO END — a real trigger, a real solve, a real saga.
//
// The pure trigger logic is already proved in tests/replanTriggers.test.ts and
// is not re-tested here. What this file exists for is the seam nothing had
// crossed until now: a trigger fires, the production solver runs against real
// rows, a RECOMMEND is raised, a dispatcher executes it, and Phase 12's saga
// actually acquires a unit. That path had no caller across two phases, so
// every part of it was individually correct and collectively unexercised.
//
// The assertions are deliberately about STATE rather than return values — a
// unit that ends HELD, a technician detached from a job, an event written —
// because a return value can be right while the rows are wrong.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { handleTrigger, executeReassignment } from '../src/commit/redispatch.js';
import { compensateSaga } from '../src/commit/saga.js';
import { MAX_REASSIGNMENTS_BEFORE_ESCALATION } from '../src/domain/replanTriggers.js';

const PREFIX = 'redisp';
const DISPATCHER = { role: 'DISPATCHER', id: `${PREFIX}-dispatcher` };
let jobCounter = 0;

// ISOLATED BY CAPABILITY, NOT BY DISTANCE. `zippy_test` is shared and
// buildDispatchSnapshot reads the WHOLE fleet, so every other fixture in the
// suite is a candidate for every job in this file. Distance does not isolate
// it: OSRM snaps a coordinate to the nearest node in its graph, and with a
// Bengaluru-only extract a Kolkata job and a Bengaluru van come back adjacent
// — measured, a seeded `unit-02` beat a co-located fixture van.
//
// So isolation is by REQUIRED CAPABILITIES, and it has to be disjoint from
// every other fixture's, not merely rare. This file's jobs need
// BRAKE_REPAIR + FLATBED_LOADING; tests/redispatchRoutes.test.ts needs
// BRAKE_REPAIR + EV_HV_CERTIFICATION. Neither crew can serve the other's work
// — a tow capability makes this job need a tow-kind unit, which rules out
// that file's van, and its EV certification is one this crew does not hold.
// Overlapping on a merely-scarce pair is not enough: both files would grant
// the same two capabilities and each would happily serve the other's jobs.
// That is exactly what happened first time round.
//
// No seeded technician holds BRAKE_REPAIR and FLATBED_LOADING together —
// brake tools go to technicians 05-12 and flatbed loading to 19-24
// (prisma/seed/technicians.ts) — so the seeded fleet is excluded too.
const EV_DISTRIBUTION = { BRAKE_FAILURE: 0.5, IMMOBILISED_UNKNOWN: 0.5 };
const REQUIRED = ['BRAKE_REPAIR', 'FLATBED_LOADING'];

const FIXTURE_LAT = 12.9352;
const FIXTURE_LNG = 77.6245;

async function freshJob(options: { assignedTo?: { unitId: string; technicianId: string } } = {}) {
  jobCounter += 1;
  const id = `${PREFIX}-job-${jobCounter}-${Date.now()}`;
  await prismaBase.job.create({
    data: {
      id,
      tenantId: `${PREFIX}-tenant`,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: options.assignedTo ? 'COMMITTED' : 'PLANNED',
      lat: FIXTURE_LAT,
      lng: FIXTURE_LNG,
      assignedUnitId: options.assignedTo?.unitId ?? null,
      assignedTechnicianId: options.assignedTo?.technicianId ?? null,
    },
  });
  // The solver reads the newest hypothesis; without one the job is skipped.
  await prismaBase.faultHypothesis.create({
    data: {
      jobId: id,
      distribution: EV_DISTRIBUTION,
      requiredCapabilityCodes: REQUIRED,
      entropy: 0,
      topFault: 'BRAKE_FAILURE',
      version: 0,
    },
  });
  if (options.assignedTo) {
    await prismaBase.unit.update({
      where: { id: options.assignedTo.unitId },
      data: { status: 'ON_JOB', version: { increment: 1 } },
    });
  }
  return id;
}

async function unitStatus(unitId: string): Promise<string> {
  return (
    await prismaBase.unit.findUniqueOrThrow({ where: { id: unitId }, select: { status: true } })
  ).status;
}

async function resetUnits(): Promise<void> {
  await prismaBase.unit.updateMany({
    where: { zoneId: `${PREFIX}-zone` },
    data: { status: 'AVAILABLE', version: { increment: 1 } },
  });
  await prismaBase.unitHold.updateMany({
    where: { unit: { zoneId: `${PREFIX}-zone` }, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'TEST_RESET' },
  });
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('a trigger becomes a reservation', () => {
  it('re-solves, recommends, and starts a real saga when executed', async () => {
    await resetUnits();
    const jobId = await freshJob();

    // 1. THE TRIGGER. Nothing is assigned yet, so any feasible crew is a
    // change, and the only EV-capable crew is the broad one.
    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      actor: DISPATCHER,
    });

    expect(outcome.outcome).toBe('REASSIGNMENT_PROPOSED');
    if (outcome.outcome !== 'REASSIGNMENT_PROPOSED') throw new Error('unreachable');
    expect(outcome.unitId).toBe(`${PREFIX}-unit-broad`);

    // A RECOMMEND, not an AUTO — this changes who drives to a breakdown.
    const action = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: outcome.actionRequestId },
      select: { tier: true, status: true, computedImpact: true },
    });
    expect(action.tier).toBe('RECOMMEND');
    expect(action.status).toBe('PENDING');

    // The solve that produced it is on the record, with its trigger, which is
    // what makes thrash measurable.
    const run = await prismaBase.solverRun.findFirst({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      select: { trigger: true },
    });
    expect(run?.trigger).toBe('TECHNICIAN_DECLINED');

    // 2. THE DISPATCHER EXECUTES. This is the seam: Phase 12's saga finally
    // has a caller.
    const executed = await executeReassignment(prismaBase, {
      actionRequestId: outcome.actionRequestId,
      actor: DISPATCHER,
    });

    expect(executed.outcome).toBe('SAGA_STARTED');
    if (executed.outcome !== 'SAGA_STARTED') throw new Error('unreachable');

    // 3. THE UNIT IS REALLY HELD. Not "the function returned a saga id" —
    // a row moved.
    expect(await unitStatus(`${PREFIX}-unit-broad`)).toBe('HELD');
    const saga = await prismaBase.dispatchOffer.findUniqueOrThrow({
      where: { id: executed.sagaId },
      select: { state: true, unitId: true, unitHolds: { select: { status: true } } },
    });
    expect(saga.state).toBe('AWAITING_LEGS');
    expect(saga.unitId).toBe(`${PREFIX}-unit-broad`);
    expect(saga.unitHolds.map((hold) => hold.status)).toEqual(['ACTIVE']);

    // And a technician offer went out — leg 2.
    expect(
      await prismaBase.technicianOffer.count({ where: { dispatchOfferId: executed.sagaId } }),
    ).toBe(1);

    await compensateSaga(prismaBase, { sagaId: executed.sagaId, reason: 'test cleanup' });
  });
});

describe('the crew already on site', () => {
  // "The current technician either waits (if useful to the new plan) or is
  // explicitly released." The released half.
  it('is explicitly released when the new plan does not use them', async () => {
    await resetUnits();
    const jobId = await freshJob({
      assignedTo: { unitId: `${PREFIX}-unit-narrow`, technicianId: `${PREFIX}-tech-narrow` },
    });

    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'DIAGNOSIS_CHANGED',
      actor: DISPATCHER,
    });
    expect(outcome.outcome).toBe('REASSIGNMENT_PROPOSED');
    if (outcome.outcome !== 'REASSIGNMENT_PROPOSED') throw new Error('unreachable');

    const action = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: outcome.actionRequestId },
      select: { computedImpact: true },
    });
    const impact = action.computedImpact as {
      technicianRetained: boolean;
      releasedTechnicianId: string | null;
    };
    expect(impact.technicianRetained).toBe(false);
    expect(impact.releasedTechnicianId).toBe(`${PREFIX}-tech-narrow`);

    // NOT RELEASED YET. While the RECOMMEND sits in a queue the old crew is
    // still the assignment — releasing on propose would leave the job with
    // nobody while a human decided.
    const beforeExecute = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { assignedTechnicianId: true },
    });
    expect(beforeExecute.assignedTechnicianId).toBe(`${PREFIX}-tech-narrow`);

    const executed = await executeReassignment(prismaBase, {
      actionRequestId: outcome.actionRequestId,
      actor: DISPATCHER,
    });
    expect(executed.outcome).toBe('SAGA_STARTED');
    if (executed.outcome !== 'SAGA_STARTED') throw new Error('unreachable');
    expect(executed.technicianRetained).toBe(false);

    // Now they are released, and the release is a durable event rather than a
    // notification that may not have arrived.
    const afterExecute = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { assignedTechnicianId: true, assignedUnitId: true },
    });
    expect(afterExecute.assignedTechnicianId).toBeNull();
    expect(afterExecute.assignedUnitId).toBeNull();
    expect(
      await prismaBase.jobEvent.count({
        where: { jobId, eventType: 'TECHNICIAN_RELEASED_FROM_JOB' },
      }),
    ).toBe(1);

    // Their van went back on the board rather than being stranded ON_JOB.
    expect(await unitStatus(`${PREFIX}-unit-narrow`)).toBe('AVAILABLE');

    await compensateSaga(prismaBase, { sagaId: executed.sagaId, reason: 'test cleanup' });
  });

  // The waiting half: a re-solve that lands on the same crew changes nothing
  // at all, which is the no-op rule seen from the technician's side.
  it('waits when the re-solve reproduces the current assignment', async () => {
    await resetUnits();
    const jobId = await freshJob({
      assignedTo: { unitId: `${PREFIX}-unit-broad`, technicianId: `${PREFIX}-tech-broad` },
    });

    // The assigned unit is ON_JOB, so it is not a candidate for itself; put it
    // back on the board first, which is the honest version of "this crew is
    // still available and still best".
    await prismaBase.unit.update({
      where: { id: `${PREFIX}-unit-broad` },
      data: { status: 'AVAILABLE', version: { increment: 1 } },
    });

    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'DRIVER_MOVED_MATERIALLY',
      actor: DISPATCHER,
    });

    expect(outcome.outcome).toBe('NO_CHANGE');
    if (outcome.outcome !== 'NO_CHANGE') throw new Error('unreachable');
    expect(outcome.reason).toBe('same assignment');

    // A NO-OP RAISES NOTHING. This is the assertion that stops every trigger
    // looking like churn in the metrics.
    expect(
      await prismaBase.actionRequest.count({
        where: { jobId, kind: { startsWith: 'REASSIGN' } },
      }),
    ).toBe(0);
    // But the solve itself is still recorded, so the trigger is measurable.
    expect(outcome.solverRunId).not.toBeNull();
  });
});

describe('thrash control', () => {
  it('escalates to a human instead of re-solving again', async () => {
    await resetUnits();
    const jobId = await freshJob();

    // Enough prior reservations on this job to trip the cap.
    for (let i = 0; i < MAX_REASSIGNMENTS_BEFORE_ESCALATION; i += 1) {
      await prismaBase.dispatchOffer.create({
        data: { jobId, state: 'REQUEUED', unitId: `${PREFIX}-unit-broad` },
      });
    }

    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      actor: DISPATCHER,
    });

    expect(outcome.outcome).toBe('ESCALATED');
    if (outcome.outcome !== 'ESCALATED') throw new Error('unreachable');

    const action = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: outcome.actionRequestId },
      select: { tier: true, kind: true, status: true },
    });
    expect(action.tier).toBe('APPROVE');
    expect(action.kind).toBe('ESCALATE_THRASHING_JOB');
    expect(action.status).toBe('PENDING');

    // NO SOLVE RAN. The cost being defended against is the oscillation, so
    // the escalation happens before the work, not after it.
    expect(await prismaBase.solverRun.count({ where: { jobId } })).toBe(0);

    // And a second trigger does not raise a second escalation — an operator
    // queue that refills itself is one nobody reads.
    const again = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'UNIT_BREAKDOWN',
      actor: DISPATCHER,
    });
    expect(again.outcome).toBe('NO_CHANGE');
    expect(
      await prismaBase.actionRequest.count({
        where: { jobId, kind: 'ESCALATE_THRASHING_JOB' },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Two crews: one that can do EV work and one that cannot. That single
// difference is what makes every re-solve above have an obvious right answer.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: `${PREFIX}-tenant` },
    update: {},
    create: { id: `${PREFIX}-tenant`, name: 'Redispatch Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'RDZ',
      name: 'Redispatch Zone',
      city: 'Bengaluru',
      centroidLat: FIXTURE_LAT,
      centroidLng: FIXTURE_LNG,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'TEST_REDISPATCH',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  // A WORKSHOP AUTHORISED FOR THIS FIXTURE'S OWN BRAND (Phase 22). Every tow
  // job now clears destination screening before anything else — a fixture
  // whose vehicle make no real seeded workshop recognises would otherwise be
  // NO_OPTION for every unit, not just VEHICLE_TYPE_INCOMPATIBLE ones. Same
  // reasoning the project's own gotchas document gives for capabilities: this
  // file owns what it needs rather than hoping it overlaps with the seed.
  // Open every day, all day, so timing can never be the reason this rejects.
  await prismaBase.workshop.upsert({
    where: { id: `${PREFIX}-workshop` },
    update: {},
    create: {
      id: `${PREFIX}-workshop`,
      code: `${PREFIX}-WS`,
      name: 'Redispatch Fixture Workshop',
      zoneId: `${PREFIX}-zone`,
      lat: FIXTURE_LAT,
      lng: FIXTURE_LNG,
      active: true,
      authorisations: {
        create: { id: `${PREFIX}-wsauth`, brand: 'TEST_REDISPATCH', level: 'STANDARD' },
      },
      hours: {
        create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          id: `${PREFIX}-wshours-${dayOfWeek}`,
          dayOfWeek,
          opens: '00:00',
          closes: '23:59',
          closed: false,
        })),
      },
    },
  });

  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-driver-user` },
    update: {},
    create: {
      id: `${PREFIX}-driver-user`,
      email: 'redisp-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Redispatch Driver',
    },
  });
  await prismaBase.driver.upsert({
    where: { id: `${PREFIX}-driver` },
    update: {},
    create: {
      id: `${PREFIX}-driver`,
      userId: `${PREFIX}-driver-user`,
      tenantId: `${PREFIX}-tenant`,
      homeZoneId: `${PREFIX}-zone`,
    },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: `${PREFIX}-tenant`,
      profileId: `${PREFIX}-profile`,
      registration: 'RDSP0001',
      colour: 'White',
    },
  });

  for (const capability of ['JUMP_START', 'BRAKE_REPAIR', 'FLATBED_LOADING']) {
    await prismaBase.capability.upsert({
      where: { code: capability },
      update: {},
      create: { code: capability, name: capability, category: 'TEST', description: 'test fixture capability' },
    });
  }

  // A tow-kind unit, because a job needing FLATBED_LOADING is rejected
  // VEHICLE_TYPE_INCOMPATIBLE on a van however well equipped its crew is.
  await crew('broad', ['BRAKE_REPAIR', 'FLATBED_LOADING'], 'FLATBED_TOW');
  await crew('narrow', ['JUMP_START'], 'VAN');

  // An all-day shift for both, anchored far enough either side of any test run
  // that feasibility never rejects on timing.
  for (const suffix of ['broad', 'narrow']) {
    await prismaBase.technicianShift.upsert({
      where: { id: `${PREFIX}-shift-${suffix}` },
      update: {
        startsAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
      create: {
        id: `${PREFIX}-shift-${suffix}`,
        technicianId: `${PREFIX}-tech-${suffix}`,
        zoneId: `${PREFIX}-zone`,
        startsAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
    });
  }
}

async function crew(suffix: string, capabilities: string[], kind: 'VAN' | 'FLATBED_TOW'): Promise<void> {
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user-${suffix}` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user-${suffix}`,
      email: `redisp-${suffix}@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: `Redispatch ${suffix}`,
    },
  });
  await prismaBase.technician.upsert({
    where: { id: `${PREFIX}-tech-${suffix}` },
    update: { active: true },
    create: {
      id: `${PREFIX}-tech-${suffix}`,
      userId: `${PREFIX}-tech-user-${suffix}`,
      employeeCode: `RDSP-${suffix.toUpperCase()}`,
      homeZoneId: `${PREFIX}-zone`,
      active: true,
    },
  });
  await prismaBase.unit.upsert({
    where: { id: `${PREFIX}-unit-${suffix}` },
    update: { status: 'AVAILABLE', kind, currentTechnicianId: `${PREFIX}-tech-${suffix}` },
    create: {
      id: `${PREFIX}-unit-${suffix}`,
      code: `RDSP-U-${suffix.toUpperCase()}`,
      kind,
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      currentTechnicianId: `${PREFIX}-tech-${suffix}`,
      lat: FIXTURE_LAT,
      lng: FIXTURE_LNG,
    },
  });

  // AUTHORITATIVE, NOT ADDITIVE. `zippy_test` persists between runs, and an
  // upsert that only ADDS capability links leaves every capability a previous
  // version of this fixture granted. That is how this crew ended up holding a
  // capability set no version of this file ever asked for, and serving another
  // test file's jobs. Clear first, then grant exactly what is listed.
  await prismaBase.technicianCapability.deleteMany({
    where: { technicianId: `${PREFIX}-tech-${suffix}` },
  });
  await prismaBase.unitCapability.deleteMany({ where: { unitId: `${PREFIX}-unit-${suffix}` } });

  for (const code of capabilities) {
    const capability = await prismaBase.capability.findUniqueOrThrow({ where: { code } });
    await prismaBase.technicianCapability.upsert({
      where: {
        technicianId_capabilityId: {
          technicianId: `${PREFIX}-tech-${suffix}`,
          capabilityId: capability.id,
        },
      },
      update: {},
      create: { technicianId: `${PREFIX}-tech-${suffix}`, capabilityId: capability.id },
    });
    await prismaBase.unitCapability.upsert({
      where: {
        unitId_capabilityId: { unitId: `${PREFIX}-unit-${suffix}`, capabilityId: capability.id },
      },
      update: {},
      create: { unitId: `${PREFIX}-unit-${suffix}`, capabilityId: capability.id },
    });
  }
}
