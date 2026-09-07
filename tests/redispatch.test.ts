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

// THIS FILE'S FIXTURE JOB IS A TOW, and that was not noticed until the
// destination guard was added.
//
// `REQUIRED` includes FLATBED_LOADING, so `faultsNeedTow` is true for every job
// here and candidate generation resolves a destination for every option — which
// is why the fixture goes to the trouble of creating an authorised workshop.
// The consequence is that the two tests below were, until now, exercising a
// reservation that could never have committed in production: leg 3 would have
// sat at PROPOSED and timed out. They passed because they compensate by hand
// rather than waiting forty-five seconds for the timeout that would have done
// it for them.
//
// So they say so, and clear the workshop before executing. What they are about
// is the reservation path and the release path; the tow path has its own
// describe block below and its own expectations.
async function withoutDestination(actionRequestId: string): Promise<void> {
  const action = await prismaBase.actionRequest.findUniqueOrThrow({
    where: { id: actionRequestId },
    select: { computedImpact: true },
  });
  const impact = action.computedImpact as Record<string, unknown>;
  expect(impact.destinationWorkshopId).toBe(`${PREFIX}-workshop`);
  await prismaBase.actionRequest.update({
    where: { id: actionRequestId },
    data: { computedImpact: { ...impact, destinationWorkshopId: null } },
  });
}

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
    // has a caller. The fixture's job is a tow — see `withoutDestination` — and
    // this test is about the reservation, not the workshop.
    await withoutDestination(outcome.actionRequestId);
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

// THE LEG NOBODY CAN ANSWER.
//
// startSaga's third leg is a destination offer, and no counterparty for it
// exists: there is no WORKSHOP role, no route accepts a destination decision,
// and `recordDestinationDecision` is called only by tests. The leg is created,
// sits at PROPOSED, and the offer-expiry worker times it out at the same
// forty-five second deadline the technician offer uses — at which point the
// whole reservation compensates.
//
// From the roadside that is a technician accepting a tow and being released
// three quarters of a minute later by a timeout they could not have
// influenced, with a notice saying a re-plan took the job. Nothing took it.
//
// So the reservation is refused before it starts. This test is the one that
// matters: it asserts that NOTHING happened — no saga, no hold, no offer — and
// that the crew already on the job was not released on the way out.
describe('a plan that needs a workshop nobody can ask', () => {
  it('refuses to start the saga and escalates instead', async () => {
    await resetUnits();
    const jobId = await freshJob();

    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      actor: DISPATCHER,
    });
    expect(outcome.outcome).toBe('REASSIGNMENT_PROPOSED');
    if (outcome.outcome !== 'REASSIGNMENT_PROPOSED') throw new Error('unreachable');

    // The plan names a workshop, and it does so on its own — this fixture's job
    // needs FLATBED_LOADING, so candidate generation resolves a destination for
    // it. Nothing is written onto the action here; the guard is being shown the
    // real output of a real solve.
    const proposed = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: outcome.actionRequestId },
      select: { computedImpact: true },
    });
    expect((proposed.computedImpact as Record<string, unknown>).destinationWorkshopId).toBe(
      `${PREFIX}-workshop`,
    );

    const executed = await executeReassignment(prismaBase, {
      actionRequestId: outcome.actionRequestId,
      actor: DISPATCHER,
    });

    expect(executed.outcome).toBe('DESTINATION_UNCONFIRMABLE');
    if (executed.outcome !== 'DESTINATION_UNCONFIRMABLE') throw new Error('unreachable');
    expect(executed.escalated).toBe(true);

    // NOTHING WAS RESERVED. Each of these is a separate way the old behaviour
    // failed: a saga row, a held van, and a technician holding an offer that
    // was going to be taken back off them.
    expect(await prismaBase.dispatchOffer.count({ where: { jobId } })).toBe(0);
    expect(await unitStatus(`${PREFIX}-unit-broad`)).toBe('AVAILABLE');
    expect(await prismaBase.technicianOffer.count({ where: { job: { id: jobId } } })).toBe(0);
    expect(await prismaBase.destinationOffer.count({ where: { jobId } })).toBe(0);

    // AND THE JOB DID NOT MOVE. A refusal must not leave it looking offered.
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, assignedUnitId: true },
    });
    expect(job.assignedUnitId).toBeNull();
    expect(job.status).not.toBe('OFFERED');
    expect(job.status).not.toBe('AWAITING_DESTINATION');

    // The operator is told, on the worklist and on the timeline — the same
    // trail a no-crew re-solve leaves, because it is the same fact for them.
    const escalation = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: executed.actionRequestId! },
      select: { kind: true, tier: true, status: true, reason: true, computedImpact: true },
    });
    expect(escalation.kind).toBe('ESCALATE_NO_FEASIBLE_PLAN');
    expect(escalation.tier).toBe('RECOMMEND');
    expect(escalation.status).toBe('PENDING');
    expect(escalation.reason).toContain('no workshop counterparty');
    expect((escalation.computedImpact as Record<string, unknown>).workshopId).toBe(
      `${PREFIX}-workshop`,
    );

    const events = await prismaBase.jobEvent.findMany({
      where: { jobId, eventType: 'NO_FEASIBLE_PLAN' },
      select: { payload: true },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).reason).toBe(
      'DESTINATION_UNCONFIRMABLE',
    );
  });

  // THE CREW ALREADY ON THE JOB KEEPS IT. A job we cannot dispatch must not
  // also lose the crew it already had — which is what would happen if the
  // guard sat after `releaseCurrentCrew` rather than before it.
  it('does not release the crew already on the job', async () => {
    await resetUnits();
    // The narrow crew is already on it, so the re-solve wants to move the job
    // and `releaseCurrentCrew` is on the path the guard has to get in front of.
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

    const executed = await executeReassignment(prismaBase, {
      actionRequestId: outcome.actionRequestId,
      actor: DISPATCHER,
    });
    expect(executed.outcome).toBe('DESTINATION_UNCONFIRMABLE');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { assignedTechnicianId: true, assignedUnitId: true },
    });
    expect(job.assignedTechnicianId).toBe(`${PREFIX}-tech-narrow`);
    expect(job.assignedUnitId).toBe(`${PREFIX}-unit-narrow`);
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

    // The fixture's job is a tow; this test is about the release. See
    // `withoutDestination`.
    await withoutDestination(outcome.actionRequestId);
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

// A RE-SOLVE THAT FINDS NOBODY HAS TO LEAVE A TRACE.
//
// This branch returned `{ outcome: 'NO_OPTION' }` and wrote nothing at all —
// no action, no job event, not even a log line. A walkthrough was lost to it:
// the solver correctly established that every van in the fleet was off shift,
// and the finding went nowhere, so the conclusion drawn from an empty board
// was that dispatch was broken.
//
// The fleet is starved by ending every shift in this file's own zone, which is
// the same thing the chaos control does and the same thing that had actually
// happened. Scoped to `${PREFIX}-` rows throughout: `zippy_test` is shared and
// a test that ended everybody's shift would take the rest of the suite with it.
describe('a re-solve that finds nobody', () => {
  it('raises a visible escalation carrying the rejection breakdown', async () => {
    await resetUnits();
    const jobId = await freshJob();

    // Nobody on shift, so every option comes back NO_TECHNICIAN_ON_SHIFT.
    await prismaBase.technicianShift.updateMany({
      where: { technician: { currentUnit: { is: { zoneId: `${PREFIX}-zone` } } } },
      data: { endsAt: new Date(Date.now() - 60_000) },
    });

    const outcome = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'TECHNICIAN_DECLINED',
      actor: DISPATCHER,
    });

    expect(outcome.outcome).toBe('NO_OPTION');
    if (outcome.outcome !== 'NO_OPTION') throw new Error('unreachable');
    expect(outcome.escalated).toBe(true);

    // 1. THE WORKLIST. A dispatcher who never clicks this job still sees it.
    const action = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: outcome.actionRequestId! },
      select: { tier: true, kind: true, status: true, reason: true, computedImpact: true },
    });
    expect(action.kind).toBe('ESCALATE_NO_FEASIBLE_PLAN');
    expect(action.tier).toBe('RECOMMEND');
    expect(action.status).toBe('PENDING');

    // THE BREAKDOWN IS IN THE REASON, which is the whole point: the counts are
    // what say "your fleet is off shift" rather than "something went wrong".
    expect(action.reason).toContain('NO_TECHNICIAN_ON_SHIFT x');

    const impact = action.computedImpact as Record<string, unknown>;
    const counts = impact.rejectionCounts as Record<string, number>;
    // The staffing gap this test created is counted, and so is everything else
    // the solve refused. NOT asserting which code dominates: this fixture's job
    // needs a flatbed, so most of the seeded fleet is also
    // VEHICLE_TYPE_INCOMPATIBLE, and pinning the winner would be asserting the
    // fixture rather than the behaviour.
    expect(counts.NO_TECHNICIAN_ON_SHIFT).toBeGreaterThan(0);
    expect(impact.optionsConsidered).toBe(
      Object.values(counts).reduce((total, count) => total + count, 0),
    );
    // The card's own three fields, so the row can be triaged without opening it.
    expect(typeof impact.reasonCode).toBe('string');
    expect(impact.whyNoCrew).toBeTruthy();
    expect(impact.recommendation).toBeTruthy();

    // 2. THE TIMELINE, as its own event type rather than only as an action —
    // "show me every job we could not plan" has to be a filter, not a grep
    // through payloads.
    const events = await prismaBase.jobEvent.findMany({
      where: { jobId, eventType: 'NO_FEASIBLE_PLAN' },
      select: { payload: true },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).breakdown).toContain(
      'NO_TECHNICIAN_ON_SHIFT',
    );

    // 3. ONE CARD, NOT TWENTY. A job whose triggers keep firing must not refill
    // the queue an operator is trying to read.
    const again = await handleTrigger(prismaBase, {
      jobId,
      trigger: 'UNIT_BREAKDOWN',
      actor: DISPATCHER,
    });
    expect(again.outcome).toBe('NO_OPTION');
    if (again.outcome !== 'NO_OPTION') throw new Error('unreachable');
    expect(again.escalated).toBe(false);
    expect(
      await prismaBase.actionRequest.count({
        where: { jobId, kind: 'ESCALATE_NO_FEASIBLE_PLAN' },
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
          closes: '24:00',
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
