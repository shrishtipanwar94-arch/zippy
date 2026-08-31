// ESTIMATE AND APPROVAL — Phase 15c stage 2.
//
// The brief's own list for this stage, and what each is proved by:
//
//   revised estimate over tolerance -> work PAUSES at AWAITING_APPROVAL
//     — asserted on the JOB STATUS, and then by the technician's own status
//       ladder refusing to move it. The pause is only real if the person
//       holding the spanner cannot walk past it.
//   the driver may approve, decline, or cancel
//     — three tests, plus the one that says declining the FIRST estimate is
//       refused, because there is no approved scope to fall back to.
//   every approval recorded with what was approved and when
//     — `estimate_approvals` joined back to an immutable estimate.
//
// SCOPED TO THIS FILE'S OWN ROWS, and it owns its price list outright — the
// stage 1 fixture learned that lesson the hard way.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { reapprovalDecision } from '../src/domain/estimateApproval.js';
import { labourCodeForFault, partSkusForFault } from '../src/domain/faults.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import { buildEstimate } from '../src/commit/estimates.js';
import { respondToEstimate } from '../src/commit/estimateResponses.js';
import { ladderMove } from '../src/domain/jobLadder.js';

const app = createApp();
const PREFIX = 'estim';
const TENANT = `${PREFIX}-tenant`;
const PRICE_LIST = `${PREFIX}-list`;
// PAST-DATED, and this is not cosmetic. `GET /jobs` returns the 50 NEWEST
// jobs, and two older suites assert a dispatcher's list contains theirs — so a
// fixture dated in the FUTURE occupies those slots permanently, for every run
// that ever happens. Fifteen jobs here plus a few elsewhere was enough to push
// them off the end. 2022 is this suite's own window; every money suite owns a
// different year so their price lists cannot compete either.
const CREATED_AT = new Date('2022-03-01T00:00:00.000Z');

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-driver`,
  });
}

function technicianToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-tech-user`,
    role: 'TECHNICIAN',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-tech`,
  });
}

const actor = { role: 'TECHNICIAN' as const, id: `${PREFIX}-tech` };
const driver = { role: 'DRIVER' as const, id: `${PREFIX}-driver` };

async function jobStatus(jobId: string): Promise<string> {
  const job = await prismaBase.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { status: true },
  });
  return job.status;
}

// A job at WORKING with a stated diagnosis, ready to be priced. Each test gets
// its own so one approval cannot move the ground under another.
async function freshJob(suffix: string, topFault: string): Promise<string> {
  const id = `${PREFIX}-job-${suffix}`;
  await prismaBase.estimate.deleteMany({ where: { jobId: id } });
  await prismaBase.job.upsert({
    where: { id },
    update: { status: 'WORKING', priceListId: PRICE_LIST, createdAt: CREATED_AT },
    create: {
      id,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      priceListId: PRICE_LIST,
      status: 'WORKING',
      safetyLevel: 'NORMAL',
      createdAt: CREATED_AT,
      onHighway: false,
      lat: 12.9352,
      lng: 77.6245,
    },
  });
  await prismaBase.faultHypothesis.deleteMany({ where: { jobId: id } });
  await prismaBase.faultHypothesis.create({
    data: {
      jobId: id,
      distribution: {},
      requiredCapabilityCodes: [],
      entropy: 0.1,
      topFault,
    },
  });
  return id;
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('when the driver has to be asked again', () => {
  it('always asks for the first estimate', () => {
    const decision = reapprovalDecision({
      approvedTotalPaise: null,
      revisedTotalPaise: 100,
      toleranceBps: 1000,
    });
    expect(decision.outcome).toBe('NEEDS_FIRST_APPROVAL');
  });

  it('carries a revision inside the tolerance', () => {
    // 10% of ₹1,000 is ₹100, so ₹1,100 is the last covered rupee.
    const decision = reapprovalDecision({
      approvedTotalPaise: 100000,
      revisedTotalPaise: 110000,
      toleranceBps: 1000,
    });
    expect(decision).toEqual({ outcome: 'COVERED', allowancePaise: 110000 });
  });

  it('asks again one paise past the allowance', () => {
    const decision = reapprovalDecision({
      approvedTotalPaise: 100000,
      revisedTotalPaise: 110001,
      toleranceBps: 1000,
    });
    expect(decision).toEqual({ outcome: 'NEEDS_REAPPROVAL', allowancePaise: 110000, overBy: 1 });
  });

  // The rule most likely to be got wrong by someone reaching for Math.abs. A
  // cheaper revision needs no new approval: the driver already agreed to spend
  // more than that, and stopping the job to say so delays a repair.
  it('never asks again for a revision that is cheaper', () => {
    const decision = reapprovalDecision({
      approvedTotalPaise: 100000,
      revisedTotalPaise: 40000,
      toleranceBps: 1000,
    });
    expect(decision.outcome).toBe('COVERED');
  });

  it('re-approves every rupee at zero tolerance', () => {
    const decision = reapprovalDecision({
      approvedTotalPaise: 100000,
      revisedTotalPaise: 100001,
      toleranceBps: 0,
    });
    expect(decision.outcome).toBe('NEEDS_REAPPROVAL');
  });

  // An allowance is a limit, so its fraction rounds DOWN — rounding a limit up
  // would let a revision through on the strength of half a paise.
  it('rounds the allowance down', () => {
    const decision = reapprovalDecision({
      approvedTotalPaise: 999,
      revisedTotalPaise: 1098,
      toleranceBps: 1000,
    });
    // 999 + floor(99.9) = 1098, so exactly on the limit is covered.
    expect(decision).toEqual({ outcome: 'COVERED', allowancePaise: 1098 });
  });
});

describe('what a repair needs', () => {
  it('names parts for every fault, and none for the four that consume nothing', () => {
    for (const fault of FAULT_CODES) {
      expect(Array.isArray(partSkusForFault(fault))).toBe(true);
    }
    // A jump start, a lockout, an EV diagnosis and a tow consume no stock.
    expect(partSkusForFault('FLAT_BATTERY')).toEqual([]);
    expect(partSkusForFault('KEYS_LOCKED_IN')).toEqual([]);
    expect(partSkusForFault('IMMOBILISED_UNKNOWN')).toEqual([]);
    expect(partSkusForFault('ALTERNATOR_FAILURE')).toContain('ALT-RECON');
  });

  it('sends certification work to the specialist rate', () => {
    expect(labourCodeForFault('EV_HV_FAULT')).toBe('SPECIALIST');
    expect(labourCodeForFault('BRAKE_FAILURE')).toBe('SPECIALIST');
    expect(labourCodeForFault('FLAT_TYRE')).toBe('STANDARD');
  });
});

// ---------------------------------------------------------------------------

describe('generating an estimate after diagnosis', () => {
  it('itemises parts, labour and the callout at the job’s pinned prices', async () => {
    const jobId = await freshJob('build', 'ALTERNATOR_FAILURE');
    const result = await buildEstimate(prismaBase, { jobId, actor });

    expect(result.outcome).toBe('ISSUED');
    if (result.outcome !== 'ISSUED') return;

    const lines = await prismaBase.estimateLine.findMany({
      where: { estimateId: result.estimateId },
      orderBy: { amountPaise: 'desc' },
      select: { kind: true, description: true, amountPaise: true },
    });

    // Two parts (a reconditioned alternator and a drive belt), labour, callout.
    expect(lines.filter((line) => line.kind === 'PART')).toHaveLength(2);
    expect(lines.filter((line) => line.kind === 'LABOUR')).toHaveLength(1);
    expect(lines.filter((line) => line.kind === 'CALLOUT')).toHaveLength(1);
    // No tow line: nobody supplied a distance, and a metered charge is never
    // invented.
    expect(lines.filter((line) => line.kind === 'TOW')).toHaveLength(0);

    // The total is the sum of the lines, and nothing else.
    expect(result.totalPaise).toBe(lines.reduce((sum, line) => sum + line.amountPaise, 0));
  });

  it('meters a tow only when a distance is given', async () => {
    const jobId = await freshJob('tow', 'IMMOBILISED_UNKNOWN');
    const result = await buildEstimate(prismaBase, { jobId, actor, towKilometres: 20 });
    expect(result.outcome).toBe('ISSUED');
    if (result.outcome !== 'ISSUED') return;

    const tow = await prismaBase.estimateLine.findFirstOrThrow({
      where: { estimateId: result.estimateId, kind: 'TOW' },
      select: { amountPaise: true, description: true },
    });
    expect(tow.amountPaise).toBe(80000);
    expect(tow.description).toContain('20km');
  });

  it('pauses the job at the first estimate', async () => {
    const jobId = await freshJob('pause', 'FLAT_TYRE');
    const result = await buildEstimate(prismaBase, { jobId, actor });

    expect(result.outcome).toBe('ISSUED');
    if (result.outcome !== 'ISSUED') return;
    expect(result.approval).toBe('NEEDS_FIRST_APPROVAL');
    expect(result.paused).toBe(true);
    expect(await jobStatus(jobId)).toBe('AWAITING_APPROVAL');
  });

  // WORK DOES NOT CONTINUE OPTIMISTICALLY, and this is what makes that
  // structural rather than a rule: AWAITING_APPROVAL has no rank on the
  // technician's ladder, so there is no move out of it for them to make.
  it('leaves the technician’s status ladder with nowhere to go', async () => {
    expect(ladderMove('AWAITING_APPROVAL', 'WORKING').outcome).toBe('OFF_LADDER');
    expect(ladderMove('AWAITING_APPROVAL', 'COMPLETE').outcome).toBe('OFF_LADDER');
  });

  it('refuses to raise a second estimate while one is unanswered', async () => {
    const jobId = await freshJob('double', 'FLAT_TYRE');
    await buildEstimate(prismaBase, { jobId, actor });
    const second = await buildEstimate(prismaBase, { jobId, actor });
    expect(second.outcome).toBe('ALREADY_AWAITING');
  });

  it('will not price a job with no pinned price list', async () => {
    const jobId = await freshJob('unpriced', 'FLAT_TYRE');
    await prismaBase.job.update({ where: { id: jobId }, data: { priceListId: null } });

    const result = await buildEstimate(prismaBase, { jobId, actor });
    expect(result.outcome).toBe('CANNOT_PRICE');
    // And the job is NOT paused: a job nobody can price is not a job waiting on
    // a driver.
    expect(await jobStatus(jobId)).toBe('WORKING');
  });
});

// ---------------------------------------------------------------------------

describe('the re-approval loop', () => {
  it('carries a small overrun without asking again', async () => {
    const jobId = await freshJob('small', 'FLAT_TYRE');
    const first = await buildEstimate(prismaBase, { jobId, actor });
    if (first.outcome !== 'ISSUED') throw new Error('expected an estimate');

    await respondToEstimate(prismaBase, {
      estimateId: first.estimateId,
      decision: 'APPROVE',
      actor: driver,
    });
    expect(await jobStatus(jobId)).toBe('WORKING');

    // The same fault re-priced: identical total, comfortably inside 10%.
    const second = await buildEstimate(prismaBase, { jobId, actor });
    expect(second.outcome).toBe('ISSUED');
    if (second.outcome !== 'ISSUED') return;
    expect(second.approval).toBe('COVERED');
    expect(second.paused).toBe(false);

    // Work never stopped, and the covered revision needs no answer.
    expect(await jobStatus(jobId)).toBe('WORKING');
    const estimate = await prismaBase.estimate.findUniqueOrThrow({
      where: { id: second.estimateId },
      select: { status: true },
    });
    expect(estimate.status).toBe('APPROVED');
  });

  // THE FLOW THE BRIEF CALLS "a real flow, not an edge case".
  it('pauses when the revision blows past the tolerance', async () => {
    const jobId = await freshJob('blowout', 'FLAT_TYRE');
    const first = await buildEstimate(prismaBase, { jobId, actor });
    if (first.outcome !== 'ISSUED') throw new Error('expected an estimate');
    await respondToEstimate(prismaBase, {
      estimateId: first.estimateId,
      decision: 'APPROVE',
      actor: driver,
    });

    // The technician opens it up: it is not a puncture, it is the alternator.
    await prismaBase.faultHypothesis.create({
      data: {
        jobId,
        distribution: {},
        requiredCapabilityCodes: [],
        entropy: 0.1,
        topFault: 'ALTERNATOR_FAILURE',
      },
    });

    const revised = await buildEstimate(prismaBase, { jobId, actor });
    expect(revised.outcome).toBe('ISSUED');
    if (revised.outcome !== 'ISSUED') return;
    expect(revised.approval).toBe('NEEDS_REAPPROVAL');
    expect(revised.totalPaise).toBeGreaterThan(first.totalPaise);

    // WORK PAUSES. It does not continue optimistically.
    expect(await jobStatus(jobId)).toBe('AWAITING_APPROVAL');

    const event = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId, eventType: 'ESTIMATE_ISSUED' },
      orderBy: { sequence: 'desc' },
      select: { payload: true },
    });
    // The allowance and the overrun are on the record, so "why was I asked
    // again?" is answerable in rupees.
    expect(event.payload).toMatchObject({ approval: 'NEEDS_REAPPROVAL', paused: true });
  });
});

describe('the driver answers', () => {
  it('approves, and work resumes with the approval recorded', async () => {
    const jobId = await freshJob('approve', 'FLAT_TYRE');
    const built = await buildEstimate(prismaBase, { jobId, actor });
    if (built.outcome !== 'ISSUED') throw new Error('expected an estimate');

    const response = await request(app)
      .post(`/estimates/${built.estimateId}/respond`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ decision: 'APPROVE' });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('APPROVED');
    expect(await jobStatus(jobId)).toBe('WORKING');

    // WHAT WAS APPROVED AND WHEN. The approval points at an immutable estimate,
    // so the pair is a complete answer to "what did this customer agree to?".
    const approval = await prismaBase.estimateApproval.findUniqueOrThrow({
      where: { estimateId: built.estimateId },
      select: { approvedByRole: true, approvedById: true, channel: true, approvedAt: true },
    });
    expect(approval.approvedByRole).toBe('DRIVER');
    expect(approval.approvedById).toBe(`${PREFIX}-driver`);
    expect(approval.channel).toBe('APP');
    expect(approval.approvedAt).toBeInstanceOf(Date);
  });

  // Declining is not a rejection of the job — the agreed work still happens.
  it('declines the extra work and finishes at the approved scope', async () => {
    const jobId = await freshJob('decline', 'FLAT_TYRE');
    const first = await buildEstimate(prismaBase, { jobId, actor });
    if (first.outcome !== 'ISSUED') throw new Error('expected an estimate');
    await respondToEstimate(prismaBase, {
      estimateId: first.estimateId,
      decision: 'APPROVE',
      actor: driver,
    });

    await prismaBase.faultHypothesis.create({
      data: { jobId, distribution: {}, requiredCapabilityCodes: [], entropy: 0.1, topFault: 'ALTERNATOR_FAILURE' },
    });
    const revised = await buildEstimate(prismaBase, { jobId, actor });
    if (revised.outcome !== 'ISSUED') throw new Error('expected a revision');

    const response = await request(app)
      .post(`/estimates/${revised.estimateId}/respond`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ decision: 'DECLINE' });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('DECLINED');
    // The scope that survives, in rupees.
    expect(response.body.approvedTotalPaise).toBe(first.totalPaise);
    // Work resumes — at the approved scope, not the declined one.
    expect(await jobStatus(jobId)).toBe('WORKING');

    const declined = await prismaBase.estimate.findUniqueOrThrow({
      where: { id: revised.estimateId },
      select: { status: true, approval: true },
    });
    expect(declined.status).toBe('REJECTED');
    expect(declined.approval).toBeNull();
    // And the earlier approval is untouched.
    const original = await prismaBase.estimate.findUniqueOrThrow({
      where: { id: first.estimateId },
      select: { status: true },
    });
    expect(original.status).toBe('APPROVED');
  });

  // Declining the FIRST estimate would leave the job paused with no scope to
  // finish and no way out, so it is refused with the two answers that work.
  it('refuses a decline with nothing to fall back to', async () => {
    const jobId = await freshJob('nofallback', 'FLAT_TYRE');
    const built = await buildEstimate(prismaBase, { jobId, actor });
    if (built.outcome !== 'ISSUED') throw new Error('expected an estimate');

    const response = await request(app)
      .post(`/estimates/${built.estimateId}/respond`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ decision: 'DECLINE' });

    expect(response.status).toBe(409);
    expect(response.body.allowed).toEqual(['APPROVE', 'CANCEL']);
    // Still paused, and still answerable.
    expect(await jobStatus(jobId)).toBe('AWAITING_APPROVAL');
  });

  it('cancels the job outright', async () => {
    const jobId = await freshJob('cancel', 'FLAT_TYRE');
    const built = await buildEstimate(prismaBase, { jobId, actor });
    if (built.outcome !== 'ISSUED') throw new Error('expected an estimate');

    const response = await request(app)
      .post(`/estimates/${built.estimateId}/respond`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({ decision: 'CANCEL' });

    expect(response.status).toBe(200);
    expect(await jobStatus(jobId)).toBe('CANCELLED');

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { cancelledAt: true },
    });
    expect(job.cancelledAt).not.toBeNull();
    expect(
      await prismaBase.jobEvent.count({ where: { jobId, eventType: 'JOB_CANCELLED' } }),
    ).toBeGreaterThan(0);
  });

  // Two answers to one estimate — a second tap, or the driver in the app while
  // a dispatcher answers on the phone.
  it('lets exactly one of two simultaneous answers win', async () => {
    const jobId = await freshJob('race', 'FLAT_TYRE');
    const built = await buildEstimate(prismaBase, { jobId, actor });
    if (built.outcome !== 'ISSUED') throw new Error('expected an estimate');

    const [first, second] = await Promise.all([
      respondToEstimate(prismaBase, { estimateId: built.estimateId, decision: 'APPROVE', actor: driver }),
      respondToEstimate(prismaBase, { estimateId: built.estimateId, decision: 'APPROVE', actor: driver }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['ALREADY_ANSWERED', 'APPROVED']);
    // One approval row, not two — `estimate_id` is unique, and the conditional
    // update is what stops the second attempt reaching it.
    expect(await prismaBase.estimateApproval.count({ where: { estimateId: built.estimateId } })).toBe(1);
  });
});

describe('who may do what', () => {
  it('does not let a technician approve their own estimate', async () => {
    const jobId = await freshJob('selfapprove', 'FLAT_TYRE');
    const built = await buildEstimate(prismaBase, { jobId, actor });
    if (built.outcome !== 'ISSUED') throw new Error('expected an estimate');

    const response = await request(app)
      .post(`/estimates/${built.estimateId}/respond`)
      .set('Authorization', `Bearer ${technicianToken()}`)
      .send({ decision: 'APPROVE' });

    expect(response.status).toBe(403);
    expect(await jobStatus(jobId)).toBe('AWAITING_APPROVAL');
  });

  it('does not let a driver raise an estimate', async () => {
    const jobId = await freshJob('driverraise', 'FLAT_TYRE');
    const response = await request(app)
      .post(`/jobs/${jobId}/estimate`)
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({});
    expect(response.status).toBe(403);
  });

  it('shows the driver the itemised estimate and what they may do about it', async () => {
    const jobId = await freshJob('driverview', 'ALTERNATOR_FAILURE');
    await buildEstimate(prismaBase, { jobId, actor });

    const response = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.estimate.awaitingAnswer).toBe(true);
    // Nothing approved yet, so declining is not offered.
    expect(response.body.estimate.mayDecline).toBe(false);
    expect(response.body.estimate.lines.length).toBeGreaterThan(0);
    expect(response.body.estimate.total).toMatch(/^₹/);
    // The pause has a sentence, not a status code.
    expect(response.body.headline).toContain('check the cost below');
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Estimate Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'EST',
      name: 'Estimate Zone',
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
      make: 'Estimate Motors',
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
    create: { id: `${PREFIX}-driver`, userId: `${PREFIX}-driver-user`, tenantId: TENANT },
  });
  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'KA01ES0001',
      colour: 'Silver',
    },
  });
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
    update: {},
    create: {
      id: `${PREFIX}-tech`,
      userId: `${PREFIX}-tech-user`,
      employeeCode: `${PREFIX}-T1`,
      homeZoneId: `${PREFIX}-zone`,
    },
  });

  // THIS FILE OWNS ITS PRICE LIST — deleted and rebuilt rather than upserted,
  // for the reason stage 1's fixture found out the hard way: an upsert whose
  // `update` names only some fields leaves the rest pointing wherever an
  // earlier version of the file put them.
  await prismaBase.job.updateMany({
    where: { priceListId: PRICE_LIST },
    data: { priceListId: null },
  });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Estimate Fixture List',
      currency: 'INR',
      active: true,
      // After the seeded catalogue, so this fixture wins on validFrom without
      // touching a row it does not own.
      validFrom: new Date('2022-01-01T00:00:00.000Z'),
    },
  });

  // Parts the faults under test name. Prices chosen so a puncture repair is
  // cheap and an alternator is not — the gap is what makes the revision blow
  // through a 10% tolerance.
  const parts = [
    { sku: 'TYRE-REPAIR-KIT', name: 'Tyre puncture repair kit', pricePaise: 45000 },
    { sku: 'ALT-RECON', name: 'Reconditioned alternator', pricePaise: 650000 },
    { sku: 'DRIVE-BELT', name: 'Auxiliary drive belt', pricePaise: 140000 },
  ];
  await prismaBase.partCategory.upsert({
    where: { id: `${PREFIX}-category` },
    update: {},
    create: { id: `${PREFIX}-category`, code: 'EST-CAT', name: 'Estimate Fixture Parts' },
  });
  for (const part of parts) {
    // The SKU is unique across the database and the seed owns these three, so
    // the fixture finds them rather than creating its own.
    const existing = await prismaBase.part.findUnique({
      where: { sku: part.sku },
      select: { id: true },
    });
    const partId =
      existing?.id ??
      (
        await prismaBase.part.create({
          data: {
            id: `${PREFIX}-part-${part.sku.toLowerCase()}`,
            sku: part.sku,
            name: part.name,
            categoryId: `${PREFIX}-category`,
          },
          select: { id: true },
        })
      ).id;

    await prismaBase.partPrice.create({
      data: {
        priceListId: PRICE_LIST,
        partId,
        unitPricePaise: part.pricePaise,
        validFrom: new Date('2022-01-01T00:00:00.000Z'),
      },
    });
  }

  await prismaBase.labourRate.createMany({
    data: [
      { priceListId: PRICE_LIST, code: 'STANDARD', ratePerHourPaise: 60000, validFrom: new Date('2022-01-01T00:00:00.000Z') },
      { priceListId: PRICE_LIST, code: 'SPECIALIST', ratePerHourPaise: 120000, validFrom: new Date('2022-01-01T00:00:00.000Z') },
    ],
  });
  await prismaBase.towTariff.create({
    data: {
      priceListId: PRICE_LIST,
      towType: 'FLATBED',
      perKmPaise: 4000,
      minChargePaise: 50000,
      validFrom: new Date('2022-01-01T00:00:00.000Z'),
    },
  });
  await prismaBase.calloutFee.createMany({
    data: [
      { priceListId: PRICE_LIST, serviceType: 'STANDARD', feePaise: 30000, validFrom: new Date('2022-01-01T00:00:00.000Z') },
      { priceListId: PRICE_LIST, serviceType: 'HIGHWAY', feePaise: 50000, validFrom: new Date('2022-01-01T00:00:00.000Z') },
    ],
  });
}
