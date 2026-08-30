// THE RESERVATION SAGA — src/commit/saga.ts.
//
// The interesting tests here are not the happy path. They are the ones where
// something legitimate happens that leaves the reservation dead: a technician
// declines, a workshop declines AFTER the technician already accepted, or the
// process dies between two legs. In every one of those the same thing must be
// true at the end — no unit left HELD, no saga left non-terminal, and the job
// back on the board.
//
// Runs against the shared `zippy_test` database rather than a container: these
// are state-machine tests, not concurrency tests. The races underneath them
// (the hold, the offer) are proved in tests/concurrency/ against a real
// container, and re-proving them here would be slower and no stronger.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import {
  startSaga,
  advanceSaga,
  compensateSaga,
  recordTechnicianDecision,
  recordDestinationDecision,
} from '../src/commit/saga.js';
import { recoverSagas } from '../src/commit/sagaRecovery.js';

const PREFIX = 'saga';
let jobCounter = 0;

// No broker in this suite; the offer-expiry queue is covered by
// tests/queues.test.ts.
const noSchedule = async (): Promise<void> => {};

async function freshJob(): Promise<string> {
  jobCounter += 1;
  const id = `${PREFIX}-job-${jobCounter}-${Date.now()}`;
  await prismaBase.job.create({
    data: {
      id,
      tenantId: `${PREFIX}-tenant`,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'PLANNED',
      lat: 12.9352,
      lng: 77.6245,
    },
  });
  return id;
}

// A unit AND its crew. `Unit.currentTechnicianId` is UNIQUE — one technician
// crews one van — so every unit in this file needs a technician of its own
// rather than sharing one fixture technician.
async function freshUnit(
  suffix: string,
): Promise<{ unitId: string; technicianId: string; version: number }> {
  const unitId = `${PREFIX}-unit-${suffix}`;
  const technicianId = `${PREFIX}-tech-${suffix}`;

  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user-${suffix}` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user-${suffix}`,
      email: `saga-tech-${suffix}@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: `Saga Technician ${suffix}`,
    },
  });
  await prismaBase.technician.upsert({
    where: { id: technicianId },
    update: {},
    create: {
      id: technicianId,
      userId: `${PREFIX}-tech-user-${suffix}`,
      employeeCode: `SAGA-EMP-${suffix.toUpperCase()}`,
      homeZoneId: `${PREFIX}-zone`,
      active: true,
    },
  });

  const unit = await prismaBase.unit.upsert({
    where: { id: unitId },
    update: { status: 'AVAILABLE', version: { increment: 1 }, currentTechnicianId: technicianId },
    create: {
      id: unitId,
      code: `SAGA-${suffix.toUpperCase()}`,
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      currentTechnicianId: technicianId,
      lat: 12.9352,
      lng: 77.6245,
    },
    select: { version: true },
  });
  return { unitId, technicianId, version: unit.version };
}

async function unitStatus(unitId: string): Promise<string> {
  const unit = await prismaBase.unit.findUniqueOrThrow({
    where: { id: unitId },
    select: { status: true },
  });
  return unit.status;
}

async function sagaState(sagaId: string): Promise<string> {
  const saga = await prismaBase.dispatchOffer.findUniqueOrThrow({
    where: { id: sagaId },
    select: { state: true },
  });
  return saga.state;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('the happy path', () => {
  it('commits when both legs accept', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('happy');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      scheduleExpiry: noSchedule,
    });
    expect(started.outcome).toBe('AWAITING_LEGS');
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('unreachable');

    expect(await unitStatus(unitId)).toBe('HELD');

    const state = await recordTechnicianDecision(prismaBase, {
      sagaId: started.sagaId,
      decision: 'ACCEPTED',
    });

    expect(state).toBe('COMMITTED');
    expect(await unitStatus(unitId)).toBe('ON_JOB');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, assignedUnitId: true, assignedTechnicianId: true },
    });
    expect(job.status).toBe('COMMITTED');
    expect(job.assignedUnitId).toBe(unitId);
    expect(job.assignedTechnicianId).toBe(technicianId);
  });
});

describe('a leg failing', () => {
  it('releases the unit and requeues the job when the technician declines', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('decline');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');

    const state = await recordTechnicianDecision(prismaBase, {
      sagaId: started.sagaId,
      decision: 'DECLINED',
    });

    expect(state).toBe('REQUEUED');
    // THE RULE THE PHASE IS BUILT AROUND: a failed saga never leaves a unit
    // held.
    expect(await unitStatus(unitId)).toBe('AVAILABLE');
    expect((await prismaBase.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status).toBe('PLANNED');
  });

  // PARTIAL COMMIT — the case the phase calls the important one. Nothing
  // failed and nothing crashed: the technician said yes and the workshop said
  // no, and the reservation is dead anyway.
  it('releases an ACCEPTED technician explicitly when the destination declines', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('partial');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      workshopId: `${PREFIX}-workshop`,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');

    // Technician accepts — and the saga does NOT commit, because leg 3 is
    // still outstanding.
    const afterTechnician = await recordTechnicianDecision(prismaBase, {
      sagaId: started.sagaId,
      decision: 'ACCEPTED',
    });
    expect(afterTechnician).toBe('AWAITING_LEGS');
    expect(await unitStatus(unitId)).toBe('HELD');

    const finalState = await recordDestinationDecision(prismaBase, {
      sagaId: started.sagaId,
      decision: 'DECLINED',
    });

    expect(finalState).toBe('REQUEUED');
    expect(await unitStatus(unitId)).toBe('AVAILABLE');

    // The technician is told, in the durable record, that the job they
    // accepted is gone — a distinct event from an offer that was merely
    // withdrawn unanswered, because the two mean different things to the
    // person holding the phone.
    const released = await prismaBase.jobEvent.count({
      where: { jobId, eventType: 'TECHNICIAN_RELEASED_AFTER_ACCEPT' },
    });
    expect(released).toBe(1);
  });

  it('is born terminal when the unit is already gone', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('lost');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      // A version the unit has moved past — the plan was stale.
      expectedUnitVersion: version - 1,
      technicianId,
      scheduleExpiry: noSchedule,
    });

    expect(started.outcome).toBe('REQUEUED');
    expect(await unitStatus(unitId)).toBe('AVAILABLE');
    // Nothing was acquired, so no offer should have been sent to anybody.
    expect(await prismaBase.technicianOffer.count({ where: { dispatchOfferId: started.sagaId } })).toBe(0);
  });
});

describe('compensation is idempotent', () => {
  it('compensating twice releases once and does not throw', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('twice');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');

    const first = await compensateSaga(prismaBase, { sagaId: started.sagaId, reason: 'test' });
    const second = await compensateSaga(prismaBase, { sagaId: started.sagaId, reason: 'test' });

    expect(first).toBe('REQUEUED');
    expect(second).toBe('REQUEUED');
    expect(await unitStatus(unitId)).toBe('AVAILABLE');

    // One release, not two — the second call found nothing ACTIVE to release.
    expect(
      await prismaBase.jobEvent.count({ where: { jobId, eventType: 'UNIT_HOLD_RELEASED' } }),
    ).toBe(1);
  });

  it('advancing a committed saga changes nothing', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('advance');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');
    await recordTechnicianDecision(prismaBase, { sagaId: started.sagaId, decision: 'ACCEPTED' });

    expect(await advanceSaga(prismaBase, started.sagaId)).toBe('COMMITTED');
    expect(await unitStatus(unitId)).toBe('ON_JOB');
  });
});

// ---------------------------------------------------------------------------
// THE MANUAL CHECK THE BUILD PLAN DESCRIBES, AS A TEST.
//
// "Kill the process between leg 2 and leg 3, restart" — a saga left in
// AWAITING_LEGS with a technician who never answered and a destination leg
// that was never sent. Simulated by starting a saga, not answering it, and
// backdating it so recovery treats it as stranded rather than live.
describe('crash recovery', () => {
  it('leaves no unit held and no saga non-terminal after a restart', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('crash');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      workshopId: `${PREFIX}-workshop`,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');
    expect(await unitStatus(unitId)).toBe('HELD');

    // The process dies here. Nothing answers; the rows sit as they are.
    await prismaBase.dispatchOffer.update({
      where: { id: started.sagaId },
      data: { proposedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const recovered = await recoverSagas(prismaBase);

    expect(recovered.map((r) => r.sagaId)).toContain(started.sagaId);
    expect(await sagaState(started.sagaId)).toBe('REQUEUED');
    // The two SQL assertions from the build plan's own check, as expectations.
    expect(await unitStatus(unitId)).toBe('AVAILABLE');
    expect(
      await prismaBase.unitHold.count({ where: { unitId, status: 'ACTIVE' } }),
    ).toBe(0);
  });

  // A saga that got all the way to ALL_ACCEPTED before the crash is FINISHED,
  // not thrown away: every party already said yes, so compensating it would
  // undo a reservation everyone agreed to.
  it('completes a saga that had already collected every acceptance', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('allaccepted');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      workshopId: `${PREFIX}-workshop`,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');

    // Both legs answered yes, and the process died before the commit landed.
    await prismaBase.technicianOffer.updateMany({
      where: { dispatchOfferId: started.sagaId },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    await prismaBase.destinationOffer.updateMany({
      where: { dispatchOfferId: started.sagaId },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });
    await prismaBase.dispatchOffer.update({
      where: { id: started.sagaId },
      data: { state: 'ALL_ACCEPTED', proposedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    await recoverSagas(prismaBase);

    expect(await sagaState(started.sagaId)).toBe('COMMITTED');
    expect(await unitStatus(unitId)).toBe('ON_JOB');
  });

  it('leaves a young saga alone, because another process may still own it', async () => {
    const jobId = await freshJob();
    const { unitId, technicianId, version } = await freshUnit('young');

    const started = await startSaga(prismaBase, {
      jobId,
      unitId,
      technicianId,
      expectedUnitVersion: version,
      scheduleExpiry: noSchedule,
    });
    if (started.outcome !== 'AWAITING_LEGS') throw new Error('setup failed');

    const recovered = await recoverSagas(prismaBase);

    expect(recovered.map((r) => r.sagaId)).not.toContain(started.sagaId);
    expect(await sagaState(started.sagaId)).toBe('AWAITING_LEGS');
    expect(await unitStatus(unitId)).toBe('HELD');

    // Left behind by this test on purpose; released here so it does not look
    // like a leak to the next reader of the database.
    await compensateSaga(prismaBase, { sagaId: started.sagaId, reason: 'test cleanup' });
  });
});

// ---------------------------------------------------------------------------
// Upserted, never torn down: job_events is append-only, so a job that has
// events cannot be deleted.

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: `${PREFIX}-tenant` },
    update: {},
    create: { id: `${PREFIX}-tenant`, name: 'Saga Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'SAGAZ',
      name: 'Saga Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'TEST_SAGA',
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
      email: 'saga-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Saga Driver',
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
      registration: 'SAGA0001',
      colour: 'White',
    },
  });
  await prismaBase.workshop.upsert({
    where: { id: `${PREFIX}-workshop` },
    update: {},
    create: {
      id: `${PREFIX}-workshop`,
      code: 'SAGA-WS-01',
      name: 'Saga Workshop',
      zoneId: `${PREFIX}-zone`,
      lat: 12.9352,
      lng: 77.6245,
    },
  });
}
