// THE DEMO FLOW, IN THE ORDER IT ACTUALLY HAPPENS.
//
// This file exists because the obvious order is wrong, and being wrong about it
// wastes an afternoon in front of three browser windows. The intuition is:
//
//    driver reports it  ->  technician accepts it  ->  dispatcher dispatches it
//
// That is NOT how this system works, and no amount of waiting on the technician
// screen will make an offer appear. The real order is:
//
//    1. driver reports the breakdown            -> job at INTAKE
//    2. driver answers the follow-up questions  -> intake complete
//    3. dispatcher solves and records a plan    -> STILL NOBODY IS OFFERED ANYTHING
//    4. driver's situation changes              -> raises a REASSIGN_* action
//    5. dispatcher EXECUTES that action         -> the saga starts, the van is held
//    6. NOW the technician has an offer         -> accept -> COMMITTED
//
// Step 3 is the one that surprises people, so it has its own negative
// assertion below: after a plan is recorded, the technician's board is still
// empty. The reservation is a separate, human-taken step — see
// INTERVIEW.md 15.41 — and the only thing that starts it is executing a
// REASSIGN_* card from the action queue.
//
// WHAT THIS TEST DOES NOT ASSERT is WHICH crew wins. `zippy_test` is shared and
// carries thousands of pending jobs and other suites' units, so the best crew
// for this job is not predictable. It asserts the ORDER instead: whoever the
// re-solve names on the action card is who gets the offer, and accepting that
// offer is what commits the job. That is the claim the demo rests on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { seedCapabilities } from '../prisma/seed/capabilities.js';
import { seedIntakeQuestions } from '../prisma/seed/intakeQuestions.js';

const app = createApp();

// Fresh ids every run: this file's job collects job_events, and an append-only
// trigger means its rows can never be deleted. Reusing an id would mean a
// second run trying to delete what it is not allowed to.
const RUN = Date.now();
const PREFIX = 'demoflow';
const TENANT = `${PREFIX}-tenant-${RUN}`;
const ZONE = `${PREFIX}-zone-${RUN}`;
const DRIVER = `${PREFIX}-driver-${RUN}`;
const VEHICLE = `${PREFIX}-vehicle-${RUN}`;
const TECHNICIAN = `${PREFIX}-tech-${RUN}`;
const UNIT = `${PREFIX}-unit-${RUN}`;

// Koramangala, so the job lands inside a zone and OSRM has real roads for it.
const CENTRE = { lat: 12.9352, lng: 77.6245 };

// What a "will not start / battery light" answer set needs, both of them:
// requiredCapabilities covers 80% of the probability mass, and that mass is
// split between a flat battery and a failed one.
const CREW_CAPABILITIES = ['JUMP_START', 'BATTERY_REPLACEMENT', 'OBD_DIAGNOSTICS'];

// The answers that keep this a flat battery rather than an alternator or a key
// fault — see the likelihood tables in src/domain/questions.ts.
const PREFERRED_ANSWERS: Record<string, string> = {
  STARTER_SOUND: 'CLICKING',
  BATTERY_LIGHT_BEFORE: 'NO',
  DASH_LIGHTS: 'DIM_OR_NONE',
  FUEL_GAUGE: 'HAS_FUEL',
  KEY_RECOGNISED: 'NORMAL',
};

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user-${RUN}`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: DRIVER,
  });
}

function dispatcherToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-dispatcher-${RUN}`,
    role: 'DISPATCHER',
    tenantId: null,
    crossTenant: true,
  });
}

function technicianToken(technicianId: string, userId: string): string {
  return issueAccessToken({
    sub: userId,
    role: 'TECHNICIAN',
    tenantId: null,
    crossTenant: false,
    actorId: technicianId,
  });
}

let jobId = '';

beforeAll(async () => {
  await buildFixture();
}, 60_000);

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('the demo flow, step by step', () => {
  it('1. the driver reports a breakdown and the job starts at INTAKE', async () => {
    const response = await request(app)
      .post('/jobs/intake')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({
        vehicleId: VEHICLE,
        symptoms: {
          primaryComplaint: 'WONT_START',
          engineCranks: 'NO',
          warningLights: ['BATTERY'],
          unusualSound: null,
          vehicleMoves: null,
        },
        location: { lat: CENTRE.lat + 0.004, lng: CENTRE.lng + 0.004, roadPosition: 'PARKING' },
      });

    expect(response.status).toBe(201);
    jobId = response.body.jobId as string;
    expect(jobId).toBeTruthy();

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, assignedUnitId: true, assignedTechnicianId: true },
    });
    expect(job.status).toBe('INTAKE');
    // Nobody is assigned. Reporting a breakdown does not reserve anybody.
    expect(job.assignedUnitId).toBeNull();
    expect(job.assignedTechnicianId).toBeNull();
  });

  it('2. answering the follow-up questions completes intake', async () => {
    for (let asked = 0; asked < 10; asked += 1) {
      const next = await request(app)
        .get(`/jobs/${jobId}/next-question`)
        .set('Authorization', `Bearer ${driverToken()}`);
      expect(next.status).toBe(200);
      if (next.body.done || !next.body.question) break;

      const question = next.body.question as { code: string; answers: { value: string }[] };
      const wanted = PREFERRED_ANSWERS[question.code];
      const chosen = question.answers.find((a) => a.value === wanted) ?? question.answers[0]!;

      const posted = await request(app)
        .post(`/jobs/${jobId}/answers`)
        .set('Authorization', `Bearer ${driverToken()}`)
        .send({ questionCode: question.code, answer: chosen.value });
      expect(posted.status).toBeLessThan(300);
    }

    const hypothesis = await prismaBase.faultHypothesis.findFirst({
      where: { jobId },
      orderBy: { version: 'desc' },
      select: { requiredCapabilityCodes: true },
    });
    // Both, because the mass is split between a flat battery and a failed one.
    expect(hypothesis?.requiredCapabilityCodes).toContain('JUMP_START');
  });

  // THE ANSWER TO "WHY IS NOTHING ON THE TECHNICIAN SCREEN?"
  //
  // A reported job is a job waiting to be planned. Nobody has been asked to go
  // to it, so there is nothing for a technician to accept. Pressing Solve on
  // the dispatcher and even recording a plan does not change this — a plan is a
  // decision written down, not a reservation. `POST /solve` is not driven here
  // because it plans the WHOLE board and `zippy_test` carries thousands of
  // pending jobs; what it would prove is asserted directly instead.
  it('3. after intake there is still no offer for anybody', async () => {
    expect(await prismaBase.technicianOffer.count({ where: { jobId } })).toBe(0);
    expect(await prismaBase.dispatchOffer.count({ where: { jobId } })).toBe(0);

    const board = await request(app)
      .get('/technician/work')
      .set('Authorization', `Bearer ${technicianToken(TECHNICIAN, `${PREFIX}-tech-user-${RUN}`)}`);
    expect(board.status).toBe(200);
    expect((board.body.offers ?? []).some((o: { jobId: string }) => o.jobId === jobId)).toBe(false);
  });

  it('4. the driver reporting a safety change raises a REASSIGN card', async () => {
    const message = await request(app)
      .post(`/jobs/${jobId}/messages`)
      .set('Authorization', `Bearer ${driverToken()}`)
      // A SENTENCE THE KEYWORD RULES MATCH, not the one WALKTHROUGH.md uses.
      //
      // `POST /messages` classifies through `classifyMessageWithAi`, which falls
      // back to the phrase list in src/domain/messageClassifier.ts when no model
      // is configured — and vitest.config.ts blanks LLM_API_KEY on purpose, so
      // the suite never calls a vendor. "move into the traffic lane" is caught
      // by the MODEL and matches no phrase ("into the traffic lane" does not
      // contain "in the lane"), so it raises nothing here. This one hits
      // 'blocking' and 'not safe' and therefore works with or without a key.
      .send({ body: 'I am blocking moving traffic and it is not safe' });
    expect(message.status).toBe(201);

    const promotions = await request(app)
      .get(`/jobs/${jobId}/promotions`)
      .set('Authorization', `Bearer ${driverToken()}`);
    const promotion = (promotions.body.promotions ?? [])[0] as { promotionId: string } | undefined;
    expect(promotion, 'the message should be flagged for the driver to confirm').toBeTruthy();

    const confirmed = await request(app)
      .post(`/promotions/${promotion!.promotionId}/confirm`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ decision: 'CONFIRMED' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.redispatch?.outcome).toBe('REASSIGNMENT_PROPOSED');

    const card = await prismaBase.actionRequest.findFirst({
      where: { jobId, status: 'PENDING', kind: { startsWith: 'REASSIGN' } },
      select: { kind: true, tier: true },
    });
    expect(card?.kind).toBe('REASSIGN_AFTER_TRIGGER');
    expect(card?.tier).toBe('RECOMMEND');
  }, 60_000);

  it('5. executing that card starts the saga, and the technician finally has an offer', async () => {
    const card = await prismaBase.actionRequest.findFirstOrThrow({
      where: { jobId, status: 'PENDING', kind: { startsWith: 'REASSIGN' } },
      select: { id: true },
    });

    const executed = await request(app)
      .post(`/actions/${card.id}/execute`)
      .set('Authorization', `Bearer ${dispatcherToken()}`)
      .send({});
    expect(executed.status).toBe(200);
    expect(executed.body.reserved).toBe(true);
    expect(executed.body.saga?.outcome).toBe('SAGA_STARTED');

    // NOW there is an offer — and only now.
    const offer = await prismaBase.technicianOffer.findFirstOrThrow({
      where: { jobId },
      select: { id: true, technicianId: true, status: true },
    });
    expect(offer.status).toBe('PROPOSED');

    // Whoever the re-solve named is who must see it on their board.
    const technician = await prismaBase.technician.findUniqueOrThrow({
      where: { id: offer.technicianId },
      select: { userId: true },
    });
    const board = await request(app)
      .get('/technician/work')
      .set('Authorization', `Bearer ${technicianToken(offer.technicianId, technician.userId)}`);
    expect(board.status).toBe(200);
    expect((board.body.offers ?? []).some((o: { jobId: string }) => o.jobId === jobId)).toBe(true);
  }, 60_000);

  it('6. accepting the offer commits the job to that crew', async () => {
    const offer = await prismaBase.technicianOffer.findFirstOrThrow({
      where: { jobId },
      select: { id: true, technicianId: true },
    });
    const technician = await prismaBase.technician.findUniqueOrThrow({
      where: { id: offer.technicianId },
      select: { userId: true },
    });

    const accepted = await request(app)
      .post(`/technician/offers/${offer.id}/respond`)
      .set('Authorization', `Bearer ${technicianToken(offer.technicianId, technician.userId)}`)
      .send({ decision: 'ACCEPTED' });

    expect(accepted.status).toBe(200);
    expect(accepted.body.sagaState).toBe('COMMITTED');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, assignedUnitId: true, assignedTechnicianId: true },
    });
    expect(job.status).toBe('COMMITTED');
    expect(job.assignedTechnicianId).toBe(offer.technicianId);
    expect(job.assignedUnitId).toBeTruthy();

    // The hold the saga took was consumed rather than left dangling.
    const hold = await prismaBase.unitHold.findFirst({
      where: { jobId },
      select: { status: true },
    });
    expect(hold?.status).toBe('CONSUMED');
  }, 60_000);
});

async function buildFixture(): Promise<void> {
  const now = new Date();

  // Vocabulary this flow reads: capability codes and the intake question
  // catalogue. Both are idempotent upserts over lookup tables.
  await seedCapabilities(prismaBase);
  await seedIntakeQuestions(prismaBase);

  await prismaBase.tenant.create({
    data: { id: TENANT, name: 'Demo Flow Tenant', kind: 'CONSUMER' },
  });
  await prismaBase.zone.create({
    data: {
      id: ZONE,
      code: `DF${RUN.toString().slice(-6)}`,
      name: 'Demo Flow Zone',
      city: 'Bengaluru',
      centroidLat: CENTRE.lat,
      centroidLng: CENTRE.lng,
    },
  });

  await prismaBase.user.create({
    data: {
      id: `${PREFIX}-driver-user-${RUN}`,
      email: `${PREFIX}-driver-${RUN}@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Flow Driver',
    },
  });
  await prismaBase.driver.create({
    data: { id: DRIVER, userId: `${PREFIX}-driver-user-${RUN}`, tenantId: TENANT, homeZoneId: ZONE },
  });
  // The token carries the tenant, and it comes from the membership rather than
  // from Driver.tenantId — without this the driver owns no vehicles.
  await prismaBase.tenantMembership.create({
    data: { id: `${PREFIX}-member-${RUN}`, tenantId: TENANT, userId: `${PREFIX}-driver-user-${RUN}`, role: 'DRIVER' },
  });

  const profile = await prismaBase.vehicleProfile.upsert({
    where: { make_model_yearFrom_yearTo: { make: 'MARUTI_SUZUKI', model: 'Swift', yearFrom: 2018, yearTo: 2024 } },
    update: {},
    create: {
      id: `${PREFIX}-profile-${RUN}`,
      make: 'MARUTI_SUZUKI',
      model: 'Swift',
      yearFrom: 2018,
      yearTo: 2024,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
    select: { id: true },
  });
  await prismaBase.vehicle.create({
    data: {
      id: VEHICLE,
      driverId: DRIVER,
      tenantId: TENANT,
      profileId: profile.id,
      registration: `KA01DF${RUN.toString().slice(-4)}`,
      colour: 'White',
    },
  });

  await prismaBase.user.create({
    data: {
      id: `${PREFIX}-tech-user-${RUN}`,
      email: `${PREFIX}-tech-${RUN}@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: 'Flow Technician',
    },
  });
  await prismaBase.technician.create({
    data: {
      id: TECHNICIAN,
      userId: `${PREFIX}-tech-user-${RUN}`,
      employeeCode: `DF-${RUN.toString().slice(-6)}`,
      homeZoneId: ZONE,
    },
  });
  await prismaBase.unit.create({
    data: {
      id: UNIT,
      code: `DF-V${RUN.toString().slice(-6)}`,
      kind: 'VAN',
      zoneId: ZONE,
      status: 'AVAILABLE',
      currentTechnicianId: TECHNICIAN,
      lat: CENTRE.lat,
      lng: CENTRE.lng,
      lastLocationAt: now,
    },
  });

  // A capability link is a join row: this file owns the set, so it clears
  // before granting rather than adding to whatever was there.
  const capabilities = await prismaBase.capability.findMany({
    where: { code: { in: CREW_CAPABILITIES } },
    select: { id: true },
  });
  await prismaBase.technicianCapability.deleteMany({ where: { technicianId: TECHNICIAN } });
  await prismaBase.unitCapability.deleteMany({ where: { unitId: UNIT } });
  for (const capability of capabilities) {
    await prismaBase.technicianCapability.create({
      data: { technicianId: TECHNICIAN, capabilityId: capability.id },
    });
    await prismaBase.unitCapability.create({ data: { unitId: UNIT, capabilityId: capability.id } });
  }

  // Relative to now, so this never goes stale the way a clock-time shift does.
  await prismaBase.technicianShift.create({
    data: {
      technicianId: TECHNICIAN,
      zoneId: ZONE,
      startsAt: new Date(now.getTime() - 60 * 60_000),
      endsAt: new Date(now.getTime() + 8 * 60 * 60_000),
    },
  });
}
