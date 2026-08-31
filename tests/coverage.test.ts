// COVERAGE — the cap, the covered/payable split, and the claim that the
// LEDGER AND THE DRIVER'S SCREEN TELL THE SAME STORY.
//
// The last one is why this file exists rather than more cases in the estimate
// and ledger suites. Those two could each be internally right and still
// disagree with one another — an estimate showing ₹0 payable while the ledger
// books a receivable is two correct-looking halves and one lie, and neither
// suite is positioned to notice. So every case here is asserted on BOTH sides
// and then on their agreement.
//
// Three scenarios, all driven end to end through the real estimate builder
// against a real contract with a real cap:
//
//   fully covered      cap above the job. ₹0 payable, nothing to the customer.
//   over the cap       the overage is genuinely owed, shown AND booked.
//   uncovered service  the contract exists but does not cover this one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { applyCoverage, isFullyCovered } from '../src/domain/coverage.js';
import {
  CUSTOMER_RECEIVABLE_ACCOUNT,
  PLATFORM_COMMISSION_ACCOUNT,
  PLATFORM_COVERAGE_COST_ACCOUNT,
  tenantReceivableAccountCode,
} from '../src/domain/ledger.js';
import { coverageTermsFor } from '../src/commit/settlement.js';
import { buildEstimate } from '../src/commit/estimates.js';
import { respondToEstimate } from '../src/commit/estimateResponses.js';
import { recordJobCompletion } from '../src/commit/earnings.js';
import { captureOnCompletion } from '../src/commit/payments.js';
import { StubProvider } from '../src/payments/stubProvider.js';
import { expectBalanced, expectLedgerBalances } from './helpers/ledgerBalance.js';

const app = createApp();
const PREFIX = 'cov';
const RUN = Date.now().toString(36);
const PRICE_LIST = `${PREFIX}-list`;
// Its own year, like every other money suite — these jobs are created directly
// but the fixture rebuilds a public price list, and overlapping windows are how
// one suite's fixture once nulled another's job.
const CREATED_AT = new Date('2024-06-01T00:00:00.000Z');
const LIST_FROM = new Date('2024-01-01T00:00:00.000Z');
const LIST_TO = new Date('2025-01-01T00:00:00.000Z');

// A flat tyre: one part, twenty minutes of standard labour, a standard callout.
const PART_PAISE = 45_000;
const LABOUR_PAISE = 19_800; // 0.33h at ₹600, from the duration model
const CALLOUT_PAISE = 30_000;
const JOB_TOTAL = PART_PAISE + LABOUR_PAISE + CALLOUT_PAISE; // ₹948

// One cap above the job and one below it, so both sides of the cap are real.
const GENEROUS_CAP = 200_000; // ₹2,000 — absorbs the whole job
const TIGHT_CAP = 60_000; // ₹600 — leaves ₹348 for the driver
const OVERAGE = JOB_TOTAL - TIGHT_CAP;

type Scenario = 'fully' | 'overcap' | 'uncovered' | 'fleet';

const TENANTS: Record<Scenario, string> = {
  fully: `${PREFIX}-tenant-fully`,
  overcap: `${PREFIX}-tenant-overcap`,
  uncovered: `${PREFIX}-tenant-uncovered`,
  fleet: `${PREFIX}-tenant-fleet`,
};

function jobIdFor(scenario: Scenario): string {
  return `${PREFIX}-${RUN}-job-${scenario}`;
}
function technicianFor(scenario: Scenario): string {
  return `${PREFIX}-${RUN}-tech-${scenario}`;
}
function driverToken(scenario: Scenario): string {
  return issueAccessToken({
    sub: `${PREFIX}-${scenario}-user`,
    role: 'DRIVER',
    tenantId: TENANTS[scenario],
    crossTenant: false,
    actorId: `${PREFIX}-${scenario}-driver`,
  });
}

type ScenarioResult = Awaited<ReturnType<typeof priceApproveAndComplete>>;
const results = new Map<Scenario, ScenarioResult>();

// EACH SCENARIO RUNS ONCE and every test in its block reads the same outcome.
// Re-running the flow per test would build a SECOND estimate — which, being
// within the tolerance of the approval already on file, is auto-approved and
// therefore has no approval row of its own. That is correct behaviour and the
// wrong shape for a per-test helper.
beforeAll(async () => {
  await buildFixture();
  for (const scenario of ['fully', 'overcap', 'uncovered', 'fleet'] as Scenario[]) {
    results.set(scenario, await priceApproveAndComplete(scenario));
  }
});

function outcomeOf(scenario: Scenario): ScenarioResult {
  const result = results.get(scenario);
  if (!result) throw new Error(`scenario ${scenario} did not run`);
  return result;
}

afterAll(async () => {
  await prismaBase.$disconnect();
});

// Prices the job, approves it as the driver, completes it, and returns what
// BOTH sides say — the estimate the driver saw and the entries the ledger
// wrote. Every scenario goes through this, so the two can never be asserted
// from different runs.
async function priceApproveAndComplete(scenario: Scenario) {
  const jobId = jobIdFor(scenario);

  const built = await buildEstimate(prismaBase, {
    jobId,
    actor: { role: 'TECHNICIAN', id: technicianFor(scenario) },
  });
  if (built.outcome !== 'ISSUED') throw new Error(`expected an estimate, got ${built.outcome}`);

  await respondToEstimate(prismaBase, {
    estimateId: built.estimateId,
    decision: 'APPROVE',
    actor: { role: 'DRIVER', id: `${PREFIX}-${scenario}-driver` },
  });

  const completion = await recordJobCompletion(prismaBase, { jobId });
  if (completion.outcome === 'NOTHING_TO_RECORD') {
    throw new Error(`expected a completion: ${completion.reason}`);
  }

  const entries = await prismaBase.ledgerEntry.findMany({
    where: { transactionId: `completion:${jobId}` },
    select: { amountPaise: true, account: { select: { code: true } } },
  });

  const approval = await prismaBase.estimateApproval.findUniqueOrThrow({
    where: { estimateId: built.estimateId },
    select: { approvedAmountPaise: true },
  });

  return {
    jobId,
    built,
    approval,
    accounts: new Map(entries.map((entry) => [entry.account.code, entry.amountPaise])),
  };
}

// ---------------------------------------------------------------------------

describe('the cap rule', () => {
  it('leaves everything payable when nothing is covered', () => {
    expect(applyCoverage(95_000, { covered: false, capPaise: null })).toEqual({
      coveredPaise: 0,
      payablePaise: 95_000,
    });
  });

  it('absorbs the whole job when the cover has no cap', () => {
    const split = applyCoverage(95_000, { covered: true, capPaise: null });
    expect(split).toEqual({ coveredPaise: 95_000, payablePaise: 0 });
    expect(isFullyCovered(split)).toBe(true);
  });

  it('absorbs the whole job when the cap is above it', () => {
    expect(applyCoverage(95_000, { covered: true, capPaise: 200_000 })).toEqual({
      coveredPaise: 95_000,
      payablePaise: 0,
    });
  });

  it('leaves the overage payable when the cap bites', () => {
    expect(applyCoverage(95_000, { covered: true, capPaise: 60_000 })).toEqual({
      coveredPaise: 60_000,
      payablePaise: 35_000,
    });
  });

  // A listed service with a zero cap is a real contract term and means the
  // customer pays for everything.
  it('covers nothing at a cap of zero', () => {
    expect(applyCoverage(95_000, { covered: true, capPaise: 0 })).toEqual({
      coveredPaise: 0,
      payablePaise: 95_000,
    });
  });

  // The property the whole feature rests on: nothing can be lost or invented.
  it('always splits the total exactly', () => {
    for (const cap of [null, 0, 1, 60_000, 95_000, 200_000]) {
      const split = applyCoverage(95_000, { covered: true, capPaise: cap });
      expect(split.coveredPaise + split.payablePaise).toBe(95_000);
    }
  });

  it('reads the cap off the contract in force', async () => {
    expect(
      await coverageTermsFor(prismaBase, {
        tenantId: TENANTS.overcap,
        onHighway: false,
        at: CREATED_AT,
      }),
    ).toEqual({ covered: true, capPaise: TIGHT_CAP });

    // A contract that lists no such service is not cover.
    expect(
      await coverageTermsFor(prismaBase, {
        tenantId: TENANTS.uncovered,
        onHighway: false,
        at: CREATED_AT,
      }),
    ).toEqual({ covered: false, capPaise: null });
  });
});

// ---------------------------------------------------------------------------

describe('a fully covered job', () => {
  it('shows the driver ₹0 payable, and an approval on file for ₹0', async () => {
    const { built, approval } = outcomeOf('fully');

    expect(built.totalPaise).toBe(JOB_TOTAL);
    expect(built.coveredPaise).toBe(JOB_TOTAL);
    expect(built.payablePaise).toBe(0);

    // THE POINT OF REQUIREMENT 3. A driver who owes nothing must not have an
    // approval on file for the full cost of the work.
    expect(approval.approvedAmountPaise).toBe(0);
  });

  it('books nothing at all to the customer receivable', async () => {
    const { accounts, jobId } = outcomeOf('fully');

    expect(accounts.has(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(false);
    expect(accounts.get(PLATFORM_COVERAGE_COST_ACCOUNT)).toBe(-JOB_TOTAL);
    // The credit side is untouched by cover: the technician still earned it and
    // the platform still made its margin.
    expect(accounts.get(PLATFORM_COMMISSION_ACCOUNT)).toBe(Math.floor((JOB_TOTAL * 2000) / 10_000));
    await expectBalanced(`completion:${jobId}`);
  });

  it('has nothing to capture', async () => {
    const { jobId } = outcomeOf('fully');
    const result = await captureOnCompletion(prismaBase, { jobId, provider: new StubProvider() });
    // Not a gateway path, and nothing owed even if it were.
    expect(['NO_GATEWAY', 'NOTHING_TO_CAPTURE']).toContain(result.outcome);
  });

  it('tells the driver’s screen the same story as the ledger', async () => {
    const { jobId, accounts } = outcomeOf('fully');

    const view = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken('fully')}`);

    expect(view.status).toBe(200);
    expect(view.body.estimate.payable).toBe('₹0');
    expect(view.body.estimate.fullyCovered).toBe(true);
    expect(view.body.estimate.covered).toBe('-₹948');

    // AGREEMENT: the screen says nothing is payable, and the ledger booked
    // nothing against the customer.
    expect(accounts.get(CUSTOMER_RECEIVABLE_ACCOUNT) ?? 0).toBe(0);
  });
});

describe('a job that runs past the cap', () => {
  it('shows the overage as payable', async () => {
    const { built, approval } = outcomeOf('overcap');

    expect(built.totalPaise).toBe(JOB_TOTAL);
    expect(built.coveredPaise).toBe(TIGHT_CAP);
    expect(built.payablePaise).toBe(OVERAGE);
    // The approval is for the overage, not the total.
    expect(approval.approvedAmountPaise).toBe(OVERAGE);
  });

  // THE OVERAGE IS A GENUINE RECEIVABLE. The driver really does owe that part,
  // and only the covered portion is absorbed.
  it('books the overage to the customer and only the cap to the contract', async () => {
    const { accounts, jobId } = outcomeOf('overcap');

    expect(accounts.get(PLATFORM_COVERAGE_COST_ACCOUNT)).toBe(-TIGHT_CAP);
    expect(accounts.get(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(-OVERAGE);
    // And the two halves still account for the whole job.
    expect(TIGHT_CAP + OVERAGE).toBe(JOB_TOTAL);
    await expectBalanced(`completion:${jobId}`);
  });

  it('tells the driver’s screen the same story as the ledger', async () => {
    const { jobId, accounts } = outcomeOf('overcap');

    const view = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken('overcap')}`);

    expect(view.body.estimate.payable).toBe('₹348');
    expect(view.body.estimate.covered).toBe('-₹600');
    expect(view.body.estimate.fullyCovered).toBe(false);

    // AGREEMENT: what the screen calls payable is exactly what the ledger
    // booked against the customer.
    expect(-(accounts.get(CUSTOMER_RECEIVABLE_ACCOUNT) ?? 0)).toBe(OVERAGE);
  });
});

describe('a contract that does not cover this service', () => {
  it('leaves the whole total payable and books it to the customer', async () => {
    const { built, accounts, approval } = outcomeOf('uncovered');

    expect(built.coveredPaise).toBe(0);
    expect(built.payablePaise).toBe(JOB_TOTAL);
    expect(approval.approvedAmountPaise).toBe(JOB_TOTAL);
    expect(accounts.get(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(-JOB_TOTAL);
    expect(accounts.has(PLATFORM_COVERAGE_COST_ACCOUNT)).toBe(false);
  });
});

describe('a fleet job past its cap', () => {
  // The same rule, with the covered half going to the fleet's own receivable
  // rather than to the platform's expense line.
  it('splits between the fleet and the driver', async () => {
    const { built, accounts, jobId } = outcomeOf('fleet');

    expect(built.coveredPaise).toBe(TIGHT_CAP);
    expect(accounts.get(tenantReceivableAccountCode(TENANTS.fleet))).toBe(-TIGHT_CAP);
    expect(accounts.get(CUSTOMER_RECEIVABLE_ACCOUNT)).toBe(-OVERAGE);
    await expectBalanced(`completion:${jobId}`);
  });
});

describe('the books as a whole', () => {
  it('stay balanced across every coverage scenario', async () => {
    await expectLedgerBalances();
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'COV',
      name: 'Coverage Zone',
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
      make: 'Coverage Motors',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });
  await prismaBase.contractTier.upsert({
    where: { id: `${PREFIX}-tier` },
    update: {},
    create: { id: `${PREFIX}-tier`, name: 'GOLD', description: 'Coverage fixture tier', priority: 30 },
  });

  // FOUR TENANTS, one per scenario, each with the contract terms its name says.
  const scenarios: {
    scenario: Scenario;
    kind: 'FLEET' | 'CONSUMER';
    covered: boolean;
    capPaise: number | null;
    path: 'CONTRACT_CONSUMER' | 'FLEET_TENANT' | 'WALK_IN';
  }[] = [
    { scenario: 'fully', kind: 'CONSUMER', covered: true, capPaise: GENEROUS_CAP, path: 'CONTRACT_CONSUMER' },
    { scenario: 'overcap', kind: 'CONSUMER', covered: true, capPaise: TIGHT_CAP, path: 'CONTRACT_CONSUMER' },
    // A contract that exists and lists nothing for this service type.
    { scenario: 'uncovered', kind: 'CONSUMER', covered: false, capPaise: null, path: 'WALK_IN' },
    { scenario: 'fleet', kind: 'FLEET', covered: true, capPaise: TIGHT_CAP, path: 'FLEET_TENANT' },
  ];

  for (const spec of scenarios) {
    const tenantId = TENANTS[spec.scenario];
    await prismaBase.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: `Coverage ${spec.scenario}`, kind: spec.kind },
    });
    await prismaBase.contract.upsert({
      where: { id: `${tenantId}-contract` },
      // Every field the fixture cares about, on update as well as create —
      // three earlier suites lost time to an update that named only what had
      // changed.
      update: { active: true, startsAt: new Date('2023-01-01T00:00:00.000Z'), endsAt: null },
      create: {
        id: `${tenantId}-contract`,
        tenantId,
        tierId: `${PREFIX}-tier`,
        name: `${spec.scenario} contract`,
        startsAt: new Date('2023-01-01T00:00:00.000Z'),
        active: true,
      },
    });
    if (spec.covered) {
      await prismaBase.coveredService.upsert({
        where: {
          contractId_serviceType: { contractId: `${tenantId}-contract`, serviceType: 'STANDARD' },
        },
        update: { covered: true, capPaise: spec.capPaise },
        create: {
          contractId: `${tenantId}-contract`,
          serviceType: 'STANDARD',
          covered: true,
          capPaise: spec.capPaise,
        },
      });
    }

    const who = spec.scenario;
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-${who}-user` },
      update: {},
      create: {
        id: `${PREFIX}-${who}-user`,
        email: `${PREFIX}-${who}@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: 'Fixture Driver',
      },
    });
    await prismaBase.driver.upsert({
      where: { id: `${PREFIX}-${who}-driver` },
      update: {},
      create: { id: `${PREFIX}-${who}-driver`, userId: `${PREFIX}-${who}-user`, tenantId },
    });
    await prismaBase.vehicle.upsert({
      where: { id: `${PREFIX}-${who}-vehicle` },
      update: {},
      create: {
        id: `${PREFIX}-${who}-vehicle`,
        driverId: `${PREFIX}-${who}-driver`,
        tenantId,
        profileId: `${PREFIX}-profile`,
        registration: `KA01CV${who.slice(0, 4).toUpperCase()}`,
        colour: 'Blue',
      },
    });

    // A technician per scenario, so a credit-side assertion is about one job.
    const technicianId = technicianFor(spec.scenario);
    await prismaBase.user.upsert({
      where: { id: `${technicianId}-user` },
      update: {},
      create: {
        id: `${technicianId}-user`,
        email: `${technicianId}@example.test`,
        passwordHash: 'not-used',
        role: 'TECHNICIAN',
        name: 'Fixture Technician',
      },
    });
    await prismaBase.technician.upsert({
      where: { id: technicianId },
      update: {},
      create: {
        id: technicianId,
        userId: `${technicianId}-user`,
        employeeCode: technicianId,
        homeZoneId: `${PREFIX}-zone`,
      },
    });
  }

  // This suite owns its price list — deleted and rebuilt, and in its own year.
  await prismaBase.job.updateMany({ where: { priceListId: PRICE_LIST }, data: { priceListId: null } });
  await prismaBase.priceList.deleteMany({ where: { id: PRICE_LIST } });
  await prismaBase.priceList.create({
    data: {
      id: PRICE_LIST,
      name: 'Coverage Fixture List',
      currency: 'INR',
      active: true,
      validFrom: LIST_FROM,
      validTo: LIST_TO,
    },
  });

  const part = await prismaBase.part.findUniqueOrThrow({
    where: { sku: 'TYRE-REPAIR-KIT' },
    select: { id: true },
  });
  await prismaBase.partPrice.create({
    data: { priceListId: PRICE_LIST, partId: part.id, unitPricePaise: PART_PAISE, validFrom: LIST_FROM },
  });
  await prismaBase.labourRate.create({
    data: { priceListId: PRICE_LIST, code: 'STANDARD', ratePerHourPaise: 60_000, validFrom: LIST_FROM },
  });
  await prismaBase.calloutFee.create({
    data: { priceListId: PRICE_LIST, serviceType: 'STANDARD', feePaise: CALLOUT_PAISE, validFrom: LIST_FROM },
  });

  // One job per scenario, at WORKING with a flat-tyre diagnosis, ready to price.
  for (const spec of scenarios) {
    const id = jobIdFor(spec.scenario);
    await prismaBase.job.upsert({
      where: { id },
      update: {},
      create: {
        id,
        tenantId: TENANTS[spec.scenario],
        driverId: `${PREFIX}-${spec.scenario}-driver`,
        vehicleId: `${PREFIX}-${spec.scenario}-vehicle`,
        zoneId: `${PREFIX}-zone`,
        priceListId: PRICE_LIST,
        settlementPath: spec.path,
        status: 'WORKING',
        safetyLevel: 'NORMAL',
        createdAt: CREATED_AT,
        assignedTechnicianId: technicianFor(spec.scenario),
        onHighway: false,
        lat: 12.9352,
        lng: 77.6245,
      },
    });
    await prismaBase.faultHypothesis.create({
      data: {
        jobId: id,
        distribution: {},
        requiredCapabilityCodes: [],
        entropy: 0.1,
        topFault: 'FLAT_TYRE',
      },
    });
  }
}
