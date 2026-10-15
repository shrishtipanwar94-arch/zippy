// POST /jobs/:id/diagnosis and the /actions queue, over HTTP.
//
// These two routes were written in Stage 1 and deliberately left UNMOUNTED
// until they had tests — a route that is live before it is tested is a route
// whose first test is a user. This file is what unlocks mounting them.
//
// What HTTP adds over the unit tests next door: the authorisation layer (only
// the technician on site may re-diagnose; only a dispatcher may act on the
// queue), the strict-schema boundary, and the tier rules expressed as status
// codes — an APPROVE action must not be executable through the execute route,
// which is the difference between a tier and a label.
//
// Isolated by capability rather than distance, for the reason spelled out in
// tests/redispatch.test.ts: OSRM snaps far-away coordinates into its own
// extract, so only a capability no seeded crew holds keeps this fixture's
// crews the ones under test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { compensateSaga } from '../src/commit/saga.js';

const app = createApp();
const PREFIX = 'rdroute';
const TENANT = `${PREFIX}-tenant`;
const REQUIRED = ['BRAKE_REPAIR', 'EV_HV_CERTIFICATION'];
let jobCounter = 0;

function technicianToken(suffix = 'narrow'): string {
  return issueAccessToken({
    sub: `${PREFIX}-tech-user-${suffix}`,
    role: 'TECHNICIAN',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-tech-${suffix}`,
  });
}

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-dispatcher`,
    role: 'DISPATCHER',
    tenantId: null,
    crossTenant: true,
  });
}

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-driver`,
  });
}

// CHOSEN BY MEASUREMENT, not by guess. The diagnosis route REPLACES the stored
// hypothesis with `classifySymptoms(payload)`, so the required capabilities
// after a re-diagnosis are whatever the classifier says — isolating the
// fixture on a hand-picked fault pair does nothing. Enumerating the payload
// space against prisma/seed/technicians.ts shows this one lands on
// `contending = BRAKE_FAILURE, EV_HV_FAULT` → `required = BRAKE_REPAIR +
// EV_HV_CERTIFICATION`, a pair NO seeded technician holds (EV goes to
// technicians 01-02, brake tools to 05-12). So only the crews this file
// creates are feasible, and the assertions are about them.
const ONSITE_SYMPTOMS = {
  primaryComplaint: 'WARNING_LIGHT',
  warningLights: ['BRAKE', 'EV_SYSTEM'],
  unusualSound: 'GRINDING',
};

async function freshJob(assigned: { unitId: string; technicianId: string }): Promise<string> {
  jobCounter += 1;
  const id = `${PREFIX}-job-${jobCounter}-${Date.now()}`;
  await prismaBase.job.create({
    data: {
      id,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'COMMITTED',
      lat: 28.6152,
      lng: 77.2095,
      assignedUnitId: assigned.unitId,
      assignedTechnicianId: assigned.technicianId,
    },
  });
  await prismaBase.faultHypothesis.create({
    data: {
      jobId: id,
      distribution: { EV_HV_FAULT: 0.5, BRAKE_FAILURE: 0.5 },
      requiredCapabilityCodes: REQUIRED,
      entropy: 1,
      topFault: 'EV_HV_FAULT',
      version: 0,
    },
  });
  return id;
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

describe('POST /jobs/:id/diagnosis', () => {
  it('rejects a driver — only the crew on site may re-diagnose', async () => {
    await resetUnits();
    const jobId = await freshJob({
      unitId: `${PREFIX}-unit-narrow`,
      technicianId: `${PREFIX}-tech-narrow`,
    });

    const response = await request(app)
      .post(`/jobs/${jobId}/diagnosis`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ symptoms: ONSITE_SYMPTOMS });

    expect(response.status).toBe(403);
  });

  it('rejects an unknown key rather than silently dropping it', async () => {
    await resetUnits();
    const jobId = await freshJob({
      unitId: `${PREFIX}-unit-narrow`,
      technicianId: `${PREFIX}-tech-narrow`,
    });

    const response = await request(app)
      .post(`/jobs/${jobId}/diagnosis`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ symptoms: ONSITE_SYMPTOMS, requiredCapabilities: ['ANYTHING'] });

    expect(response.status).toBe(400);
  });

  it('404s a job the caller cannot see, rather than 403', async () => {
    const response = await request(app)
      .post('/jobs/does-not-exist/diagnosis')
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ symptoms: ONSITE_SYMPTOMS });

    expect(response.status).toBe(404);
  });

  // THE SIGNATURE FLOW. The crew on site cannot do the new job, so the
  // response tells THEM what happens next — a sentence, not a status code —
  // and a RECOMMEND appears for a dispatcher.
  it('tells a crew who can no longer resolve it that a release is pending', async () => {
    await resetUnits();
    const jobId = await freshJob({
      unitId: `${PREFIX}-unit-narrow`,
      technicianId: `${PREFIX}-tech-narrow`,
    });

    const response = await request(app)
      .post(`/jobs/${jobId}/diagnosis`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ symptoms: ONSITE_SYMPTOMS, note: 'brake line is cut' });

    expect(response.status).toBe(200);
    expect(response.body.reassigned).toBe(true);
    expect(response.body.technicianOutcome.status).toBe('RELEASE_PENDING');
    expect(response.body.technicianOutcome.detail).toMatch(/dispatcher/);

    // The belief was replaced and the change is on the job's own timeline,
    // which is what drives the driver's live view.
    expect(
      await prismaBase.jobEvent.count({ where: { jobId, eventType: 'DIAGNOSIS_CHANGED' } }),
    ).toBe(1);

    // NOT RELEASED YET — the crew stays put until a dispatcher confirms.
    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { assignedTechnicianId: true },
    });
    expect(job.assignedTechnicianId).toBe(`${PREFIX}-tech-narrow`);
  });

  it('tells a crew who can still resolve it to stay, and moves nobody', async () => {
    await resetUnits();
    const jobId = await freshJob({
      unitId: `${PREFIX}-unit-broad`,
      technicianId: `${PREFIX}-tech-broad`,
    });

    const response = await request(app)
      .post(`/jobs/${jobId}/diagnosis`)
      .set('Authorization', `Bearer ${technicianToken('broad')}`)
      .send({ symptoms: ONSITE_SYMPTOMS });

    expect(response.status).toBe(200);
    expect(response.body.reassigned).toBe(false);

    // An AUTO action, executed on the spot: nobody wants to approve telling a
    // customer their van is still coming.
    const action = await prismaBase.actionRequest.findFirstOrThrow({
      where: { jobId, kind: 'NOTIFY_DIAGNOSIS_CONFIRMED' },
      select: { tier: true, status: true },
    });
    expect(action.tier).toBe('AUTO');
    expect(action.status).toBe('EXECUTED');

    expect(
      await prismaBase.actionRequest.count({ where: { jobId, kind: { startsWith: 'REASSIGN' } } }),
    ).toBe(0);
  });
});

describe('the /actions queue', () => {
  it('is dispatcher-only', async () => {
    const response = await request(app)
      .get('/actions')
      .set('Authorization', `Bearer ${technicianToken()}`);
    expect(response.status).toBe(403);
  });

  it('lists what is still waiting on a person', async () => {
    const response = await request(app)
      .get('/actions')
      .set('Authorization', `Bearer ${dispatcherToken()}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.actions)).toBe(true);
    // Nothing already dealt with appears in the queue.
    for (const action of response.body.actions) {
      expect(['RECOMMEND', 'APPROVE']).toContain(action.tier);
    }
  });

  // THE TIER RULE, AS A STATUS CODE. An APPROVE action is blocked pending
  // sign-off by definition; letting it through the execute route would make
  // the tier decorative.
  it('refuses to execute an APPROVE action', async () => {
    const job = await freshJob({
      unitId: `${PREFIX}-unit-broad`,
      technicianId: `${PREFIX}-tech-broad`,
    });
    const action = await prismaBase.actionRequest.create({
      data: {
        jobId: job,
        tier: 'APPROVE',
        kind: 'ESCALATE_THRASHING_JOB',
        reason: 'test',
        status: 'PENDING',
      },
      select: { id: true },
    });

    const response = await request(app)
      .post(`/actions/${action.id}/execute`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('requires_approval');
  });

  it('records who signed off an APPROVE action', async () => {
    const job = await freshJob({
      unitId: `${PREFIX}-unit-broad`,
      technicianId: `${PREFIX}-tech-broad`,
    });
    const action = await prismaBase.actionRequest.create({
      data: {
        jobId: job,
        tier: 'APPROVE',
        kind: 'ESCALATE_THRASHING_JOB',
        reason: 'test',
        status: 'PENDING',
      },
      select: { id: true },
    });

    const response = await request(app)
      .post(`/actions/${action.id}/approve`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({ decision: 'APPROVED', note: 'serving it late' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('APPROVED');

    const approval = await prismaBase.approvalRecord.findUniqueOrThrow({
      where: { actionRequestId: action.id },
      select: { approvedByRole: true, approvedById: true, decision: true, note: true },
    });
    expect(approval.approvedByRole).toBe('DISPATCHER');
    expect(approval.approvedById).toBe(`${PREFIX}-dispatcher`);
    expect(approval.decision).toBe('APPROVED');
    expect(approval.note).toBe('serving it late');
  });

  it('409s a second decision on the same action', async () => {
    const job = await freshJob({
      unitId: `${PREFIX}-unit-broad`,
      technicianId: `${PREFIX}-tech-broad`,
    });
    const action = await prismaBase.actionRequest.create({
      data: { jobId: job, tier: 'APPROVE', kind: 'CANCEL_JOB', reason: 'test', status: 'PENDING' },
      select: { id: true },
    });
    const send = () =>
      request(app)
        .post(`/actions/${action.id}/approve`)
        .set('Authorization', `Bearer ${dispatcherToken()}`)
        .send({ decision: 'REJECTED' });

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_resolved');
  });

  // END TO END OVER HTTP: diagnosis change → RECOMMEND → dispatcher executes
  // → a unit is actually held. The whole Phase 13 story in one test.
  it('executes a recommended reassignment into a real reservation', async () => {
    await resetUnits();
    const jobId = await freshJob({
      unitId: `${PREFIX}-unit-narrow`,
      technicianId: `${PREFIX}-tech-narrow`,
    });

    await request(app)
      .post(`/jobs/${jobId}/diagnosis`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ symptoms: ONSITE_SYMPTOMS });

    const recommend = await prismaBase.actionRequest.findFirstOrThrow({
      where: { jobId, kind: { startsWith: 'REASSIGN' }, status: 'PENDING' },
      select: { id: true, tier: true },
    });
    expect(recommend.tier).toBe('RECOMMEND');

    const response = await request(app)
      .post(`/actions/${recommend.id}/execute`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.reserved).toBe(true);
    expect(response.body.saga.outcome).toBe('SAGA_STARTED');

    // A row moved: the better-equipped van is held.
    const unit = await prismaBase.unit.findUniqueOrThrow({
      where: { id: `${PREFIX}-unit-broad` },
      select: { status: true },
    });
    expect(unit.status).toBe('HELD');

    // And the crew who could not do the job was explicitly released.
    expect(
      await prismaBase.jobEvent.count({
        where: { jobId, eventType: 'TECHNICIAN_RELEASED_FROM_JOB' },
      }),
    ).toBe(1);

    await compensateSaga(prismaBase, {
      sagaId: response.body.saga.sagaId,
      reason: 'test cleanup',
    });
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Redispatch Route Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'RDRT',
      name: 'Redispatch Route Zone',
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
      make: 'TEST_RD_ROUTE',
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
      email: 'rdroute-driver@example.test',
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Route Driver',
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
      registration: 'RDRT0001',
      colour: 'White',
    },
  });
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-dispatcher` },
    update: {},
    create: {
      id: `${PREFIX}-dispatcher`,
      email: 'rdroute-dispatcher@example.test',
      passwordHash: 'not-used',
      role: 'DISPATCHER',
      name: 'Route Dispatcher',
    },
  });

  await crew('broad', ['JUMP_START', 'BRAKE_REPAIR', 'EV_HV_CERTIFICATION']);
  await crew('narrow', ['JUMP_START']);
}

async function crew(suffix: string, capabilities: string[]): Promise<void> {
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user-${suffix}` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user-${suffix}`,
      email: `rdroute-${suffix}@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: `Route ${suffix}`,
    },
  });
  await prismaBase.technician.upsert({
    where: { id: `${PREFIX}-tech-${suffix}` },
    update: { active: true },
    create: {
      id: `${PREFIX}-tech-${suffix}`,
      userId: `${PREFIX}-tech-user-${suffix}`,
      employeeCode: `RDRT-${suffix.toUpperCase()}`,
      homeZoneId: `${PREFIX}-zone`,
      active: true,
    },
  });
  await prismaBase.unit.upsert({
    where: { id: `${PREFIX}-unit-${suffix}` },
    update: { status: 'AVAILABLE', currentTechnicianId: `${PREFIX}-tech-${suffix}` },
    create: {
      id: `${PREFIX}-unit-${suffix}`,
      code: `RDRT-U-${suffix.toUpperCase()}`,
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'AVAILABLE',
      currentTechnicianId: `${PREFIX}-tech-${suffix}`,
      lat: 28.6152,
      lng: 77.2095,
    },
  });
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
    const capability = await prismaBase.capability.upsert({
      where: { code },
      update: {},
      create: { code, name: code, category: 'TEST', description: 'test fixture capability' },
    });
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
