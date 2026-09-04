// PHASE 20 — TENANCY AND CONTRACTS, and the four claims the phase check names:
//
//   1. a contract expiring mid-incident does not re-price the job
//   2. a vehicle registered to two tenants is rejected AT REGISTRATION
//   3. a HIGH_RISK consumer beats a GOLD contract job for the last van
//   4. cross-tenant contention raises an APPROVE card with both costs priced
//
// SCOPED TO THIS FILE'S OWN ROWS THROUGHOUT. `zippy_test` is shared and vitest
// runs files in parallel, so every id here starts `p20-` and every assertion
// names rows this file created. The two Job rows the contention test writes
// carry no location and no hypothesis, which is what keeps them invisible to
// `buildDispatchSnapshot` and therefore out of every other suite's solve; the
// jobs created through real intake are dated in the PAST and cancelled at the
// end of the run, because `job_events` is append-only and they can never be
// deleted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { solve } from '../src/engine/solve.js';
import type { DispatchOption, DispatchSnapshot, JobForDispatch } from '../src/engine/candidates.js';
import { scoreOption } from '../src/engine/cost.js';
import { NO_PARTS_MODELLED } from '../src/engine/partSourcing.js';
import { NO_DESTINATION_NEEDED } from '../src/engine/destinationSelection.js';
import {
  avoidedBreachPenaltyPaise,
  breachProbability,
  remainingWindowMinutes,
} from '../src/domain/contractExposure.js';
import {
  deprioritisedConsumerJobs,
  findContestedResources,
} from '../src/domain/contractContention.js';
import { raiseContentionApprovals } from '../src/commit/contention.js';
import { slaPolicyIdInForce } from '../src/commit/contractTerms.js';
import { buildDispatchSnapshot } from '../src/commit/dispatchSnapshot.js';
import { createIntakeJob } from '../src/intake/createJob.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';

const app = createApp();
const P = 'p20';

// EVERY FIXTURE DATE IS IN THE PAST. A future-dated job outranks `now()` in
// every run that will ever happen and would squat forever on the fifty-newest
// list two other suites assert against.
const CONTRACT_START = new Date('2026-01-01T00:00:00Z');
const CONTRACT_END = new Date('2026-05-01T00:00:00Z');
const DURING_CONTRACT = new Date('2026-04-01T09:00:00Z');
const AFTER_CONTRACT = new Date('2026-06-01T09:00:00Z');

const GOLD_PENALTY_PAISE = 250_000;

function distribution(weights: Partial<FaultDistribution>): FaultDistribution {
  const full = {} as FaultDistribution;
  for (const fault of FAULT_CODES) full[fault] = weights[fault] ?? 0;
  return full;
}

// ---------------------------------------------------------------------------
// The exposure arithmetic — pure, no database.

describe('a contract promise, priced', () => {
  it('treats an arrival inside half the remaining window as safe', () => {
    expect(breachProbability(10, 60)).toBe(0);
    expect(breachProbability(30, 60)).toBe(0);
  });

  it('rises to certainty as the estimate approaches the deadline', () => {
    expect(breachProbability(45, 60)).toBeCloseTo(0.5, 6);
    expect(breachProbability(60, 60)).toBe(1);
    expect(breachProbability(90, 60)).toBe(1);
  });

  it('calls the window certain once it has closed', () => {
    expect(breachProbability(5, 0)).toBe(1);
    expect(breachProbability(5, -20)).toBe(1);
  });

  // The credit is what a dispatch AVOIDS, so an already-breached job has
  // nothing left to save. A sunk penalty must not tilt the assignment.
  it('offers no credit for a job whose window has already closed', () => {
    const terms = { tier: 'GOLD' as const, breachPenaltyPaise: GOLD_PENALTY_PAISE };
    expect(avoidedBreachPenaltyPaise(terms, 5, -10)).toBe(0);
  });

  it('credits the whole penalty for a comfortable arrival and nothing for a late one', () => {
    const terms = { tier: 'GOLD' as const, breachPenaltyPaise: GOLD_PENALTY_PAISE };
    expect(avoidedBreachPenaltyPaise(terms, 10, 60)).toBe(GOLD_PENALTY_PAISE);
    expect(avoidedBreachPenaltyPaise(terms, 60, 60)).toBe(0);
  });

  it('credits nothing at all to a job with no contract behind it', () => {
    expect(avoidedBreachPenaltyPaise(null, 10, 60)).toBe(0);
  });

  it('measures the window from when the job was raised, not from now', () => {
    const createdAt = new Date('2026-04-01T09:00:00Z');
    const now = new Date('2026-04-01T09:20:00Z');
    expect(remainingWindowMinutes(30, createdAt, now)).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// The cost term, and its sign.

const OPTION: DispatchOption = {
  unitId: 'u1',
  technicianId: 't1',
  estimatedTravelMinutes: 8,
  travelEstimateDegraded: false,
  estimatedTravelKm: 4,
  resolvableFaults: ['FLAT_BATTERY'],
  skillResolvableFaults: ['FLAT_BATTERY'],
  partSourcing: NO_PARTS_MODELLED,
  destination: NO_DESTINATION_NEEDED,
  coveredFaultProbability: 1,
  missingCapabilities: [],
};

function engineJob(overrides: Partial<JobForDispatch> = {}): JobForDispatch {
  return {
    id: `${P}-engine-job`,
    lat: 12.9352,
    lng: 77.6245,
    faultDistribution: distribution({ FLAT_BATTERY: 1 }),
    createdAt: DURING_CONTRACT,
    slaResponseMinutes: null,
    contract: null,
    parkingLevel: null,
    onHighway: false,
    vehicleMake: 'MARUTI_SUZUKI',
    vehicleEvClass: null,
    safetyLevel: 'NORMAL',
    ...overrides,
  };
}

describe('contractSlaExposure enters the cost function as a credit', () => {
  const goldJob = engineJob({
    slaResponseMinutes: 30,
    contract: { tier: 'GOLD', breachPenaltyPaise: GOLD_PENALTY_PAISE },
  });
  const walkInJob = engineJob();

  it('makes a contract job cheaper to serve than the same job without a contract', () => {
    const gold = scoreOption(OPTION, goldJob, DURING_CONTRACT, 'BALANCED');
    const walkIn = scoreOption(OPTION, walkInJob, DURING_CONTRACT, 'BALANCED');

    // The sign is the whole point: priced as a positive cost, the GOLD job
    // would be the expensive one and would LOSE a contested van.
    expect(gold.contractSlaExposure.value).toBeLessThan(0);
    expect(walkIn.contractSlaExposure.value).toBe(0);
    expect(gold.total).toBeLessThan(walkIn.total);
  });

  it('gives a slower crew a smaller credit than a faster one, never a larger one', () => {
    const fast = scoreOption(OPTION, goldJob, DURING_CONTRACT, 'BALANCED');
    const slow = scoreOption(
      { ...OPTION, estimatedTravelMinutes: 29 },
      goldJob,
      DURING_CONTRACT,
      'BALANCED',
    );
    expect(slow.contractSlaExposure.value).toBeGreaterThan(fast.contractSlaExposure.value);
  });

  it('leans on the credit ten times harder under PROTECT_CONTRACTS', () => {
    const balanced = scoreOption(OPTION, goldJob, DURING_CONTRACT, 'BALANCED');
    const protect = scoreOption(OPTION, goldJob, DURING_CONTRACT, 'PROTECT_CONTRACTS');

    expect(protect.contractSlaExposure.weight).toBeCloseTo(
      balanced.contractSlaExposure.weight * 10,
      10,
    );
    expect(protect.contractSlaExposure.value).toBe(balanced.contractSlaExposure.value);
  });
});

// ---------------------------------------------------------------------------
// SAFETY OUTRANKS CONTRACT TIER — the phase's flagged check.
//
// One van, two jobs, and the contract job is the one the cost function wants: a
// GOLD penalty is worth about a hundred points and every other difference here
// is worth a handful. The consumer job wins anyway, and only because it is
// HIGH_RISK — which is invariant 4 holding in the GLOBAL ASSIGNMENT rather than
// only inside one job's ranking.

const ALL_DAY_SHIFT = {
  startsAt: new Date('2026-04-01T00:00:00Z'),
  endsAt: new Date('2026-04-01T23:59:00Z'),
};

function oneVanSnapshot(): DispatchSnapshot {
  return {
    units: [
      {
        id: `${P}-van`,
        zoneId: `${P}-z`,
        currentTechnicianId: `${P}-tech`,
        capabilityCodes: ['JUMP_START'],
        lat: 12.9352,
        lng: 77.6245,
        kind: 'VAN',
        status: 'AVAILABLE',
      },
    ],
    technicians: [{ id: `${P}-tech`, capabilityCodes: ['JUMP_START'] }],
    shifts: [{ technicianId: `${P}-tech`, ...ALL_DAY_SHIFT }],
    zones: [{ id: `${P}-z`, centroidLat: 12.9352, centroidLng: 77.6245 }],
  };
}

async function planFor(jobs: JobForDispatch[], label: string) {
  const outcome = await solve({
    jobs,
    snapshot: oneVanSnapshot(),
    now: DURING_CONTRACT,
    jobZone: new Map(jobs.map((job) => [job.id, `${P}-z`])),
    zonePartitionThreshold: 1_000_000,
  });
  return outcome.plans.find((candidate) => candidate.label === label)!;
}

describe('safety outranks contract tier, lexicographically', () => {
  const goldJob = engineJob({
    id: `${P}-gold-job`,
    slaResponseMinutes: 30,
    contract: { tier: 'GOLD', breachPenaltyPaise: GOLD_PENALTY_PAISE },
    safetyLevel: 'NORMAL',
  });
  const consumerJob = engineJob({ id: `${P}-consumer-job`, safetyLevel: 'NORMAL' });

  it('gives the last van to the GOLD contract job when both are NORMAL', async () => {
    const plan = await planFor([goldJob, consumerJob], 'BALANCED');
    expect(plan.assignments.map((a) => a.jobId)).toEqual([`${P}-gold-job`]);
    expect(plan.unassignedJobIds).toEqual([`${P}-consumer-job`]);
  });

  it('gives it to the HIGH_RISK consumer instead — a tier cannot buy its way past safety', async () => {
    const highRiskConsumer = { ...consumerJob, safetyLevel: 'HIGH_RISK' as const };
    const plan = await planFor([goldJob, highRiskConsumer], 'BALANCED');

    expect(plan.assignments.map((a) => a.jobId)).toEqual([`${P}-consumer-job`]);
    expect(plan.unassignedJobIds).toEqual([`${P}-gold-job`]);
  });

  // The strongest form of the claim: the plan built to favour contracts hardest
  // still cannot reorder two different safety levels.
  it('holds even under PROTECT_CONTRACTS', async () => {
    const highRiskConsumer = { ...consumerJob, safetyLevel: 'HIGH_RISK' as const };
    const plan = await planFor([goldJob, highRiskConsumer], 'PROTECT_CONTRACTS');

    expect(plan.assignments.map((a) => a.jobId)).toEqual([`${P}-consumer-job`]);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant contention — detected, priced, and never resolved alone.

describe('cross-tenant contention is named rather than settled', () => {
  const jobs = [
    { id: 'contract-job', hasContract: true, safetyLevel: 'NORMAL' },
    { id: 'consumer-job', hasContract: false, safetyLevel: 'NORMAL' },
  ];
  const options = [
    { jobId: 'contract-job', unitId: 'van', cost: 12 },
    { jobId: 'consumer-job', unitId: 'van', cost: 40 },
  ];

  it('finds the unit both jobs wanted, priced both ways', () => {
    const contested = findContestedResources({
      jobs,
      options,
      assignments: [{ jobId: 'contract-job', unitId: 'van' }],
      unassignedJobIds: ['consumer-job'],
    });

    expect(contested).toHaveLength(1);
    expect(contested[0]).toMatchObject({
      unitId: 'van',
      winnerJobId: 'contract-job',
      loserJobId: 'consumer-job',
      winnerCost: 12,
      loserCost: 40,
      contractJobId: 'contract-job',
      consumerJobId: 'consumer-job',
    });
  });

  // Invariant 4 working is not a trade-off anybody needs to approve.
  it('says nothing when the two jobs are at different safety levels', () => {
    const contested = findContestedResources({
      jobs: [jobs[0]!, { ...jobs[1]!, safetyLevel: 'HIGH_RISK' }],
      options,
      assignments: [{ jobId: 'consumer-job', unitId: 'van' }],
      unassignedJobIds: ['contract-job'],
    });
    expect(contested).toEqual([]);
  });

  // Two contract jobs competing is ordinary scarcity, and the cost function is
  // allowed to settle that on its own.
  it('says nothing when both jobs are contract jobs', () => {
    const contested = findContestedResources({
      jobs: [jobs[0]!, { id: 'consumer-job', hasContract: true, safetyLevel: 'NORMAL' }],
      options,
      assignments: [{ jobId: 'contract-job', unitId: 'van' }],
      unassignedJobIds: ['consumer-job'],
    });
    expect(contested).toEqual([]);
  });

  it('names the consumer jobs a contract-protecting plan leaves waiting', () => {
    expect(
      deprioritisedConsumerJobs({
        protectPlanUnassignedJobIds: ['consumer-job', 'other-contract-job'],
        recommendedPlanUnassignedJobIds: ['other-contract-job'],
        consumerJobIds: ['consumer-job'],
      }),
    ).toEqual(['consumer-job']);
  });

  it('names nothing when the recommended plan would not have served them either', () => {
    expect(
      deprioritisedConsumerJobs({
        protectPlanUnassignedJobIds: ['consumer-job'],
        recommendedPlanUnassignedJobIds: ['consumer-job'],
        consumerJobIds: ['consumer-job'],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The database half.

beforeAll(async () => {
  await clearFixture();
  await buildFixture();
}, 60_000);

afterAll(async () => {
  await clearFixture();
  await prismaBase.$disconnect().catch(() => undefined);
});

describe('the terms in force at creation are the terms the job is served under', () => {
  it('resolves the SLA policy from the contract open at that instant', async () => {
    const duringId = await slaPolicyIdInForce(prismaBase, {
      tenantId: `${P}-fleet`,
      onHighway: false,
      at: DURING_CONTRACT,
    });
    expect(duringId).toBe(`${P}-sla-standard`);
  });

  it('resolves nothing once the contract has expired', async () => {
    const afterId = await slaPolicyIdInForce(prismaBase, {
      tenantId: `${P}-fleet`,
      onHighway: false,
      at: AFTER_CONTRACT,
    });
    expect(afterId).toBeNull();
  });

  it('pins that policy onto the job at intake', async () => {
    const created = await intakeJob();
    expect(created.slaPolicyId).toBe(`${P}-sla-standard`);

    const row = await prismaBase.job.findUniqueOrThrow({
      where: { id: created.jobId },
      select: { slaPolicyId: true },
    });
    expect(row.slaPolicyId).toBe(`${P}-sla-standard`);
  });

  // THE PHASE'S FIRST NAMED TEST. The contract lapses while the incident is
  // live; the job keeps the window and the penalty it was created under, and
  // the solver keeps optimising for them.
  it('keeps the window and the penalty after the contract expires mid-incident', async () => {
    const created = await intakeJob();

    await prismaBase.contract.update({
      where: { id: `${P}-contract` },
      data: { active: false, endsAt: DURING_CONTRACT },
    });

    try {
      const { jobs } = await buildDispatchSnapshot(prismaBase, { jobIds: [created.jobId] });
      const job = jobs.find((candidate) => candidate.id === created.jobId);

      expect(job).toBeDefined();
      expect(job!.slaResponseMinutes).toBe(30);
      expect(job!.contract).toEqual({ tier: 'GOLD', breachPenaltyPaise: GOLD_PENALTY_PAISE });
    } finally {
      await prismaBase.contract.update({
        where: { id: `${P}-contract` },
        data: { active: true, endsAt: CONTRACT_END },
      });
    }
  });
});

describe('a vehicle belongs to exactly one tenant', () => {
  it('registers a vehicle into the fleet manager own tenant', async () => {
    const response = await request(app)
      .post('/vehicles')
      .set('Authorization', `Bearer ${fleetManagerToken()}`)
      .send({
        driverId: `${P}-driver`,
        profileId: `${P}-profile`,
        registration: 'KA-01-P20-0001',
        colour: 'White',
      });

    expect(response.status).toBe(201);
    const vehicle = await prismaBase.vehicle.findUniqueOrThrow({
      where: { id: response.body.vehicleId as string },
      select: { tenantId: true, registration: true },
    });
    expect(vehicle.tenantId).toBe(`${P}-fleet`);
    // Normalised on the way in, so a plate cannot be registered twice by
    // punctuation alone.
    expect(vehicle.registration).toBe('KA01P200001');
  });

  // THE PHASE'S SECOND NAMED TEST, in both of its forms.
  it('refuses a plate already registered to another tenant', async () => {
    const response = await request(app)
      .post('/vehicles')
      .set('Authorization', `Bearer ${otherFleetManagerToken()}`)
      .send({
        driverId: `${P}-other-driver`,
        profileId: `${P}-profile`,
        // The same plate, punctuated differently — the check must see through
        // that, or it is not a check.
        registration: 'ka01 p20 0001',
        colour: 'White',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('REGISTERED_TO_ANOTHER_TENANT');
  });

  it('refuses a vehicle whose driver belongs to a different tenant', async () => {
    const response = await request(app)
      .post('/vehicles')
      .set('Authorization', `Bearer ${fleetManagerToken()}`)
      .send({
        // This driver is on the OTHER tenant, so the vehicle would belong to
        // one tenant by its own column and to another through its driver.
        driverId: `${P}-other-driver`,
        profileId: `${P}-profile`,
        registration: 'KA-01-P20-0002',
        colour: 'Blue',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('DRIVER_TENANT_MISMATCH');
  });

  it('keeps a driver out of the registration desk entirely', async () => {
    const response = await request(app)
      .post('/vehicles')
      .set('Authorization', `Bearer ${driverToken()}`)
      .send({
        driverId: `${P}-driver`,
        profileId: `${P}-profile`,
        registration: 'KA-01-P20-0003',
        colour: 'Red',
      });
    expect(response.status).toBe(403);
  });
});

describe('a contested van becomes an APPROVE card', () => {
  const contested = {
    unitId: `${P}-van`,
    winnerJobId: `${P}-contract-job`,
    loserJobId: `${P}-consumer-job`,
    winnerCost: 12.5,
    loserCost: 41.25,
    contractJobId: `${P}-contract-job`,
    consumerJobId: `${P}-consumer-job`,
    safetyLevel: 'NORMAL',
  };

  it('raises it on the job that lost, with both costs on the card', async () => {
    const raised = await raiseContentionApprovals(prismaBase, [contested]);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.jobId).toBe(`${P}-consumer-job`);

    const action = await prismaBase.actionRequest.findUniqueOrThrow({
      where: { id: raised[0]!.actionRequestId },
      select: { tier: true, status: true, kind: true, reason: true, computedImpact: true },
    });

    // APPROVE, not RECOMMEND: this one blocks pending a person.
    expect(action.tier).toBe('APPROVE');
    expect(action.status).toBe('PENDING');
    expect(action.kind).toBe('APPROVE_CROSS_TENANT_CONTENTION');
    expect(action.reason).toContain(`${P}-van`);
    expect(action.computedImpact).toMatchObject({
      winnerCost: 12.5,
      loserCost: 41.25,
      contractJobId: `${P}-contract-job`,
      consumerJobId: `${P}-consumer-job`,
    });
  });

  // The planner re-runs on every trigger. Asking the same question every two
  // seconds until somebody answers is not escalation, it is noise.
  it('does not ask again while the first card is still pending', async () => {
    const again = await raiseContentionApprovals(prismaBase, [contested]);
    expect(again).toEqual([]);

    const cards = await prismaBase.actionRequest.count({
      where: { jobId: `${P}-consumer-job`, kind: 'APPROVE_CROSS_TENANT_CONTENTION' },
    });
    expect(cards).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture

function fleetManagerToken(): string {
  return issueAccessToken({
    sub: `${P}-fm-user`,
    role: 'FLEET_MANAGER',
    tenantId: `${P}-fleet`,
    crossTenant: false,
  });
}

function otherFleetManagerToken(): string {
  return issueAccessToken({
    sub: `${P}-other-fm-user`,
    role: 'FLEET_MANAGER',
    tenantId: `${P}-other-fleet`,
    crossTenant: false,
  });
}

function driverToken(): string {
  return issueAccessToken({
    sub: `${P}-driver-user`,
    role: 'DRIVER',
    tenantId: `${P}-fleet`,
    crossTenant: false,
    actorId: `${P}-driver`,
  });
}

// A job through the REAL intake path, so the pinning under test is the pinning
// production does. Dated in the past and cancelled by clearFixture, because
// `job_events` is append-only and the row can never be removed.
async function intakeJob() {
  return createIntakeJob(prismaBase, {
    driverId: `${P}-driver`,
    vehicleId: `${P}-intake-vehicle`,
    tenantId: `${P}-fleet`,
    symptoms: {
      primaryComplaint: 'FLAT_TYRE',
      engineCranks: null,
      warningLights: [],
      unusualSound: null,
      vehicleMoves: null,
    },
    safety: {
      trafficSpeedKph: null,
      blockingLiveLane: false,
      smokeOrBurningSmell: false,
      fuelSmell: false,
      overheating: false,
      driverAlone: false,
      vulnerablePassengers: false,
    },
    location: {
      lat: 12.9352,
      lng: 77.6245,
      headingDegrees: null,
      accuracyMetres: null,
      nearestExit: null,
      kmMarker: null,
      landmark: null,
      roadPosition: 'PARKING',
      parkingLevel: null,
    },
    actor: { role: 'DRIVER', id: `${P}-driver` },
    at: DURING_CONTRACT,
  });
}

// NOTHING THIS FILE OWNS CAN BE DELETED, and that is not an oversight.
//
// A job carries `job_events`, and that table rejects DELETE — so deleting a job
// fails on the cascade, and with the jobs still there the driver, vehicle and
// tenant behind them cannot go either. The fixture is therefore IDEMPOTENT
// rather than disposable: every row is upserted, and the only cleanup is the
// part that has to be undone for the next run to mean anything.
//
// TWO THINGS ARE UNDONE.
//   Jobs are CANCELLED. A terminal status is what keeps them out of every other
//   suite's dispatch snapshot, which is the actual hazard a leftover job poses.
//   The APPROVE cards are deleted, because the contention test asserts that the
//   FIRST call raises one and the second does not — a card left pending from
//   last run would make the first call a no-op.
async function clearFixture(): Promise<void> {
  await prismaBase.job.updateMany({
    where: { tenantId: { in: [`${P}-fleet`, `${P}-other-fleet`] }, status: { not: 'CANCELLED' } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  await prismaBase.actionRequest.deleteMany({ where: { jobId: { startsWith: `${P}-` } } });

  // The vehicles the registration tests create. They are the one thing here
  // with no job behind it, so they genuinely can go — and they must, or the
  // second run registers a plate the first run already took.
  await prismaBase.vehicle.deleteMany({
    where: { registration: { startsWith: 'KA01P200' } },
  });
}

// UPSERTS THROUGHOUT, because clearFixture cannot delete any of this — see its
// comment. Every run has to be able to rebuild on top of the last one rows.
async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${P}-zone` },
    update: {},
    create: {
      id: `${P}-zone`,
      code: 'P20Z',
      name: 'Contracts Fixture Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${P}-profile` },
    update: {},
    create: {
      id: `${P}-profile`,
      make: 'P20TEST',
      model: 'Contracts',
      yearFrom: 2020,
      yearTo: 2026,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  for (const [tenantId, suffix] of [
    [`${P}-fleet`, ''],
    [`${P}-other-fleet`, 'other-'],
  ] as const) {
    await prismaBase.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: `Contracts ${tenantId}`, kind: 'FLEET' },
    });
    await prismaBase.user.upsert({
      where: { id: `${P}-${suffix}fm-user` },
      update: {},
      create: {
        id: `${P}-${suffix}fm-user`,
        email: `${P}-${suffix}fm@example.test`,
        passwordHash: 'not-used',
        role: 'FLEET_MANAGER',
        name: 'Fleet Manager',
        memberships: { create: { id: `${P}-${suffix}mem`, tenantId, role: 'FLEET_MANAGER' } },
      },
    });
    await prismaBase.user.upsert({
      where: { id: `${P}-${suffix}driver-user` },
      update: {},
      create: {
        id: `${P}-${suffix}driver-user`,
        email: `${P}-${suffix}driver@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: 'Fixture Driver',
        driver: { create: { id: `${P}-${suffix}driver`, tenantId } },
      },
    });
  }

  // The GOLD contract everything in this file is served under. Its own tier and
  // its own contract, so the test that expires one mid-incident is never
  // touching a row another suite reads.
  await prismaBase.contractTier.upsert({
    where: { id: `${P}-tier-gold` },
    update: {},
    create: { id: `${P}-tier-gold`, name: 'GOLD', priority: 30, description: 'Fixture GOLD' },
  });
  // The window is RESTORED on every run, not merely created: one test closes it
  // and puts it back in a `finally`, and a crash between the two would
  // otherwise leave the next run with a permanently expired contract.
  await prismaBase.contract.upsert({
    where: { id: `${P}-contract` },
    update: { active: true, startsAt: CONTRACT_START, endsAt: CONTRACT_END },
    create: {
      id: `${P}-contract`,
      tenantId: `${P}-fleet`,
      tierId: `${P}-tier-gold`,
      name: 'Contracts fixture contract',
      startsAt: CONTRACT_START,
      endsAt: CONTRACT_END,
      active: true,
    },
  });
  await prismaBase.slaPolicy.upsert({
    where: { id: `${P}-sla-standard` },
    update: { responseMinutes: 30, breachPenaltyPaise: GOLD_PENALTY_PAISE },
    create: {
      id: `${P}-sla-standard`,
      contractId: `${P}-contract`,
      serviceType: 'STANDARD',
      responseMinutes: 30,
      resolutionMinutes: 90,
      breachPenaltyPaise: GOLD_PENALTY_PAISE,
    },
  });
  await prismaBase.coveredService.upsert({
    where: { contractId_serviceType: { contractId: `${P}-contract`, serviceType: 'STANDARD' } },
    update: {},
    create: {
      id: `${P}-covered-standard`,
      contractId: `${P}-contract`,
      serviceType: 'STANDARD',
      covered: true,
    },
  });

  await prismaBase.vehicle.upsert({
    where: { id: `${P}-intake-vehicle` },
    update: {},
    create: {
      id: `${P}-intake-vehicle`,
      driverId: `${P}-driver`,
      tenantId: `${P}-fleet`,
      profileId: `${P}-profile`,
      registration: 'KA01P20INTAKE',
      colour: 'Silver',
    },
  });

  // Two bare Job rows for the contention card. No location and no hypothesis,
  // so `buildDispatchSnapshot` skips them and they can never turn up as
  // candidates in another suite's solve.
  for (const [id, tenantId, driverId] of [
    [`${P}-contract-job`, `${P}-fleet`, `${P}-driver`],
    [`${P}-consumer-job`, `${P}-other-fleet`, `${P}-other-driver`],
  ] as const) {
    await prismaBase.job.upsert({
      where: { id },
      update: {},
      create: {
        id,
        tenantId,
        driverId,
        vehicleId: `${P}-intake-vehicle`,
        zoneId: `${P}-zone`,
        status: 'INTAKE',
        createdAt: DURING_CONTRACT,
      },
    });
  }
}
