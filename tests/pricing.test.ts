// PRICING — Phase 15c stage 1.
//
// Two claims, and only one of them is arithmetic.
//
//   1. THE ARITHMETIC. Quantity times a rate, in integer paise, with the tow
//      minimum charge as the one rule that is not a multiplication.
//
//   2. THE RULE THAT MATTERS: a job prices against the list in force AT
//      CREATION and is never re-priced. The brief's own test for it is "a
//      price list expiring mid-job → the job settles at creation-time prices",
//      and it is the last test in this file. It is the whole reason
//      `jobs.price_list_id` exists rather than the current list being resolved
//      whenever somebody needs a number.
//
// SCOPED TO THIS FILE'S OWN ROWS. `zippy_test` is shared and vitest runs files
// in parallel, so this file creates its own price lists with its own prefix and
// never asserts anything about the seeded catalogue.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaBase } from '../src/infra/prismaBase.js';
import { formatRupees, roundToPaise, sumPaise } from '../src/domain/money.js';
import { priceCallout, priceLabour, priceParts, priceTow, totalOf } from '../src/domain/pricing.js';
import { priceListInForce } from '../src/pricing/priceList.js';
import { calloutRate, labourRate, partRate, towRate } from '../src/pricing/rateCard.js';
import { createIntakeJob } from '../src/intake/createJob.js';

const PREFIX = 'pricing';
const TENANT = `${PREFIX}-tenant`;

// Three lists, so precedence and expiry are both testable.
//
// DATED PAST THE SEEDED CATALOGUE ON PURPOSE. `zippy_test` is shared, and the
// seed's "Standard 2026" list is public and OPEN-ENDED — so it is in force at
// every instant from 2026 onward and competes with anything this fixture puts
// in the same window. Placing these later makes the fixture win on
// `validFrom`, deterministically, without this file having to delete or edit a
// row it does not own.
const PUBLIC_OLD = `${PREFIX}-public-old`;   // ended
const PUBLIC_NOW = `${PREFIX}-public-now`;   // open-ended
const TENANT_LIST = `${PREFIX}-tenant-list`; // this tenant's own, open-ended

const IN_OLD = new Date('2030-06-01T00:00:00.000Z');
const IN_NOW = new Date('2031-06-01T00:00:00.000Z');
const BOUNDARY = new Date('2031-01-01T00:00:00.000Z');

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

// ---------------------------------------------------------------------------

describe('money is integer paise', () => {
  it('rounds only where a multiplication can produce a fraction', () => {
    expect(roundToPaise(80000 * 1.5)).toBe(120000);
    // Half-up, and it is a choice — see the header of src/domain/money.ts.
    expect(roundToPaise(0.5)).toBe(1);
    expect(roundToPaise(1.5)).toBe(2);
  });

  it('sums without floating-point drift', () => {
    // The three amounts that break a naive float sum in rupees: 0.1 + 0.2.
    expect(sumPaise([10, 20])).toBe(30);
    expect(sumPaise([64000, 80000, 90000])).toBe(234000);
  });

  it('groups digits the way an Indian invoice does', () => {
    expect(formatRupees(234000)).toBe('₹2,340');
    // Lakhs, not thousands: ₹1,44,000 rather than ₹144,000.
    expect(formatRupees(14400000)).toBe('₹1,44,000');
  });
});

describe('what a line comes to', () => {
  it('prices a part by quantity', () => {
    const line = priceParts(
      { partId: 'part-belt', description: 'Drive belt', unitPricePaise: 64000 },
      2,
    );
    expect(line).toMatchObject({ kind: 'PART', quantity: 2, amountPaise: 128000 });
    expect(line.refId).toBe('part-belt');
  });

  it('prices labour by the hour, keeping the hours on the line', () => {
    const line = priceLabour({ code: 'STANDARD', ratePerHourPaise: 60000 }, 1.5);
    expect(line.amountPaise).toBe(90000);
    // Itemised means reconstructable: "1.5h @ ₹600" is readable off the row.
    expect(line.quantity).toBe(1.5);
    expect(line.unitPricePaise).toBe(60000);
    expect(line.description).toContain('1.5h');
  });

  it('meters a tow by distance', () => {
    const line = priceTow({ towType: 'FLATBED', perKmPaise: 4000, minChargePaise: 50000 }, 20);
    expect(line.amountPaise).toBe(80000);
    expect(line.description).not.toContain('minimum');
  });

  // The one rule here that is not a multiplication. A two-hundred-metre tow
  // still costs a truck and a driver an hour of their day.
  it('applies the minimum charge to a short tow, and says so', () => {
    const line = priceTow({ towType: 'FLATBED', perKmPaise: 4000, minChargePaise: 50000 }, 2);
    expect(line.amountPaise).toBe(50000);
    expect(line.description).toContain('minimum charge');
  });

  it('prices a callout as a flat fee of quantity one', () => {
    const line = priceCallout({ serviceType: 'HIGHWAY', feePaise: 50000 });
    expect(line).toMatchObject({ quantity: 1, unitPricePaise: 50000, amountPaise: 50000 });
  });

  it('totals a set of lines', () => {
    const lines = [
      priceParts({ partId: 'p', description: 'Drive belt', unitPricePaise: 64000 }, 1),
      priceLabour({ code: 'STANDARD', ratePerHourPaise: 80000 }, 1),
      priceCallout({ serviceType: 'STANDARD', feePaise: 30000 }),
    ];
    expect(totalOf(lines)).toBe(174000);
  });
});

// ---------------------------------------------------------------------------

describe('which list is in force', () => {
  it('picks the list whose window contains the instant', async () => {
    expect(await priceListInForce(prismaBase, { tenantId: null, at: IN_OLD })).toBe(PUBLIC_OLD);
    expect(await priceListInForce(prismaBase, { tenantId: null, at: IN_NOW })).toBe(PUBLIC_NOW);
  });

  // `validTo` is exclusive: a list that runs to midnight on the 1st is not in
  // force at midnight on the 1st, and its successor is.
  it('treats the end of a window as exclusive and the start as inclusive', async () => {
    expect(await priceListInForce(prismaBase, { tenantId: null, at: BOUNDARY })).toBe(PUBLIC_NOW);
  });

  it("prefers a tenant's own list over the public one", async () => {
    expect(await priceListInForce(prismaBase, { tenantId: TENANT, at: IN_NOW })).toBe(TENANT_LIST);
  });

  it('never gives one tenant another tenant’s prices', async () => {
    const other = await priceListInForce(prismaBase, {
      tenantId: `${PREFIX}-other-tenant`,
      at: IN_NOW,
    });
    expect(other).toBe(PUBLIC_NOW);
  });

  it('answers null rather than guessing when nothing is in force', async () => {
    // Before the seeded catalogue as well as this fixture's.
    const before = await priceListInForce(prismaBase, {
      tenantId: null,
      at: new Date('2019-01-01T00:00:00.000Z'),
    });
    expect(before).toBeNull();
  });

  // Deactivating a tenant's list drops them back to the public one, which is a
  // more useful claim than "returns null" — and it is what a fleet whose
  // negotiated rates lapsed should actually get.
  it('ignores a deactivated list and falls back', async () => {
    await prismaBase.priceList.update({ where: { id: TENANT_LIST }, data: { active: false } });
    expect(await priceListInForce(prismaBase, { tenantId: TENANT, at: IN_NOW })).toBe(PUBLIC_NOW);
    await prismaBase.priceList.update({ where: { id: TENANT_LIST }, data: { active: true } });
  });
});

describe('the rates on a list, as at an instant', () => {
  it('reads the rate whose own window contains the instant', async () => {
    const rate = await labourRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      code: 'STANDARD',
      at: IN_NOW,
    });
    expect(rate?.ratePerHourPaise).toBe(80000);
  });

  // A row inside a list is versioned too, so pinning the LIST is not enough on
  // its own — the instant has to travel down as well, or the job re-prices
  // through the back door.
  it('reads the earlier rate for an earlier instant on the same list', async () => {
    const rate = await labourRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      code: 'SUPERSEDED',
      at: new Date('2031-02-01T00:00:00.000Z'),
    });
    expect(rate?.ratePerHourPaise).toBe(50000);

    const later = await labourRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      code: 'SUPERSEDED',
      at: new Date('2031-09-01T00:00:00.000Z'),
    });
    expect(later?.ratePerHourPaise).toBe(70000);
  });

  // The only lookup that reads a relation: a part price carries the part's
  // NAME, because an itemised line says "Drive belt" and not a part id.
  it('reads a part price with the words that go on the invoice', async () => {
    const rate = await partRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      partId: `${PREFIX}-part`,
      at: IN_NOW,
    });
    expect(rate).toEqual({
      partId: `${PREFIX}-part`,
      description: 'Fixture drive belt',
      unitPricePaise: 64000,
    });
  });

  it('reads a tow tariff and a callout fee', async () => {
    const tow = await towRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      towType: 'FLATBED',
      at: IN_NOW,
    });
    expect(tow).toMatchObject({ perKmPaise: 4000, minChargePaise: 50000 });

    const callout = await calloutRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      serviceType: 'STANDARD',
      at: IN_NOW,
    });
    expect(callout?.feePaise).toBe(30000);
  });

  // Not an exception: "this list does not price that" is a real answer, and a
  // throw would make a gap in a catalogue look like a system failure.
  it('answers null for a rate the list does not carry', async () => {
    const missing = await labourRate(prismaBase, {
      priceListId: PUBLIC_NOW,
      code: 'NOT_ON_THIS_LIST',
      at: IN_NOW,
    });
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('a job pins its prices at creation', () => {
  it('records the list in force when the job was raised', async () => {
    const result = await createIntakeJob(prismaBase, {
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      tenantId: TENANT,
      symptoms: { primaryComplaint: 'FLAT_TYRE', engineCranks: null, warningLights: [], unusualSound: null, vehicleMoves: null },
      safety: { trafficSpeedKph: null, blockingLiveLane: false, smokeOrBurningSmell: false, fuelSmell: false, overheating: false, driverAlone: false, vulnerablePassengers: false },
      location: { lat: 12.9352, lng: 77.6245, headingDegrees: null, nearestExit: null, kmMarker: null, landmark: null, roadPosition: 'PARKING', parkingLevel: null },
      actor: null,
      at: IN_NOW,
    });

    // The tenant's own list, because they have one.
    expect(result.priceListId).toBe(TENANT_LIST);

    const job = await prismaBase.job.findUniqueOrThrow({
      where: { id: result.jobId },
      select: { priceListId: true },
    });
    expect(job.priceListId).toBe(TENANT_LIST);

    // On the audit trail too, so "it was decided at creation" is a record and
    // not only a column somebody could have written later.
    const created = await prismaBase.jobEvent.findFirstOrThrow({
      where: { jobId: result.jobId, eventType: 'JOB_CREATED' },
      select: { payload: true },
    });
    expect(created.payload).toMatchObject({ priceListId: TENANT_LIST });
  });

  // THE BRIEF'S OWN TEST. "A price list expiring mid-job → the job settles at
  // creation-time prices."
  it('settles at creation-time prices when the list expires mid-job', async () => {
    const jobId = `${PREFIX}-job-midflight`;
    await prismaBase.job.update({ where: { id: jobId }, data: { priceListId: PUBLIC_NOW } });

    const pinned = await prismaBase.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { priceListId: true, createdAt: true },
    });

    const before = await labourRate(prismaBase, {
      priceListId: pinned.priceListId!,
      code: 'STANDARD',
      at: pinned.createdAt,
    });

    // THE LIST ENDS WHILE THE JOB IS STILL RUNNING, and a successor takes over.
    await prismaBase.priceList.update({
      where: { id: PUBLIC_NOW },
      data: { validTo: new Date('2031-07-01T00:00:00.000Z') },
    });

    // The catalogue has moved on: nothing is in force for a walk-in now.
    const nowInForce = await priceListInForce(prismaBase, {
      tenantId: null,
      at: new Date('2031-08-01T00:00:00.000Z'),
    });
    // Something else takes over — the seeded catalogue, in this database. What
    // matters is that it is no longer the list this job was quoted on.
    expect(nowInForce).not.toBe(PUBLIC_NOW);

    // The job has not. Its pinned id and its creation instant still resolve to
    // exactly the rate it was quoted, because neither reads the clock.
    const after = await labourRate(prismaBase, {
      priceListId: pinned.priceListId!,
      code: 'STANDARD',
      at: pinned.createdAt,
    });
    expect(after).toEqual(before);
    expect(after?.ratePerHourPaise).toBe(80000);

    // Put it back, so this file is re-runnable against a shared database.
    await prismaBase.priceList.update({ where: { id: PUBLIC_NOW }, data: { validTo: null } });
  });

  // Payment is never on the dispatch critical path. A stranded driver does not
  // wait for a catalogue somebody forgot to activate.
  it('still creates the job when no list is in force', async () => {
    const result = await createIntakeJob(prismaBase, {
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      tenantId: null,
      symptoms: { primaryComplaint: 'FLAT_TYRE', engineCranks: null, warningLights: [], unusualSound: null, vehicleMoves: null },
      safety: { trafficSpeedKph: null, blockingLiveLane: false, smokeOrBurningSmell: false, fuelSmell: false, overheating: false, driverAlone: false, vulnerablePassengers: false },
      location: { lat: 12.9352, lng: 77.6245, headingDegrees: null, nearestExit: null, kmMarker: null, landmark: null, roadPosition: 'PARKING', parkingLevel: null },
      actor: null,
      // Before any list this fixture defines begins.
      at: new Date('2019-03-01T00:00:00.000Z'),
    });

    expect(result.jobId).toBeTruthy();
    expect(result.priceListId).toBeNull();
  });
});

// ---------------------------------------------------------------------------

async function buildFixture(): Promise<void> {
  // AGE WHAT EARLIER RUNS LEFT BEHIND. Two tests here create jobs through real
  // intake at IN_NOW (2031) to prove the list resolution, and those jobs cannot
  // be deleted — `job_events` is append-only. Future-dated, they would sit in
  // the newest 50 forever and crowd out the suites that assert a dispatcher's
  // list contains their own jobs. The assertions read the RETURN VALUE of
  // intake, not the stored date, so ageing them afterwards costs nothing.
  //
  // The fixture job re-upserted below gets its real date back immediately.
  await prismaBase.job.updateMany({
    where: { driverId: `${PREFIX}-driver` },
    data: { createdAt: new Date('2019-06-01T00:00:00.000Z') },
  });

  await buildActors();

  // THIS FIXTURE OWNS ITS PRICE LISTS, so it deletes them and rebuilds rather
  // than upserting into whatever an earlier run left behind. The CLAUDE.md
  // gotcha, hit again and from a new angle: an `upsert` whose `update` names
  // only the fields that changed leaves every field it does NOT name pointing
  // wherever the previous version of this file put it. Renaming the list ids
  // mid-edit stranded every rate on a list that no longer existed, and each
  // lookup quietly answered null.
  //
  // The jobs have to let go first — `jobs.price_list_id` is a foreign key, and
  // that includes jobs earlier runs of the pinning tests created.
  await prismaBase.job.updateMany({
    where: { priceListId: { startsWith: PREFIX } },
    data: { priceListId: null },
  });
  await prismaBase.priceList.deleteMany({ where: { id: { startsWith: PREFIX } } });

  await prismaBase.priceList.createMany({
    data: [
      {
        id: PUBLIC_OLD,
        name: 'Pricing Fixture Old',
        tenantId: null,
        currency: 'INR',
        active: true,
        validFrom: new Date('2030-01-01T00:00:00.000Z'),
        validTo: new Date('2031-01-01T00:00:00.000Z'),
      },
      {
        id: PUBLIC_NOW,
        name: 'Pricing Fixture Now',
        tenantId: null,
        currency: 'INR',
        active: true,
        validFrom: new Date('2031-01-01T00:00:00.000Z'),
        validTo: null,
      },
      {
        id: TENANT_LIST,
        name: 'Pricing Fixture Tenant',
        tenantId: TENANT,
        currency: 'INR',
        active: true,
        validFrom: new Date('2031-01-01T00:00:00.000Z'),
        validTo: null,
      },
    ],
  });

  // Rates on the open-ended public list, including one that is superseded
  // WITHIN the list — which is what proves the instant has to travel down past
  // the list itself.
  await prismaBase.labourRate.createMany({
    data: [
      {
        id: `${PREFIX}-labour-standard`,
        priceListId: PUBLIC_NOW,
        code: 'STANDARD',
        ratePerHourPaise: 80000,
        validFrom: new Date('2031-01-01T00:00:00.000Z'),
        validTo: null,
      },
      {
        id: `${PREFIX}-labour-old`,
        priceListId: PUBLIC_NOW,
        code: 'SUPERSEDED',
        ratePerHourPaise: 50000,
        validFrom: new Date('2031-01-01T00:00:00.000Z'),
        validTo: new Date('2031-06-01T00:00:00.000Z'),
      },
      {
        id: `${PREFIX}-labour-new`,
        priceListId: PUBLIC_NOW,
        code: 'SUPERSEDED',
        ratePerHourPaise: 70000,
        validFrom: new Date('2031-06-01T00:00:00.000Z'),
        validTo: null,
      },
    ],
  });

  await prismaBase.towTariff.create({
    data: {
      id: `${PREFIX}-tow-flatbed`,
      priceListId: PUBLIC_NOW,
      towType: 'FLATBED',
      perKmPaise: 4000,
      minChargePaise: 50000,
      validFrom: new Date('2031-01-01T00:00:00.000Z'),
    },
  });
  await prismaBase.partPrice.create({
    data: {
      id: `${PREFIX}-partprice`,
      priceListId: PUBLIC_NOW,
      partId: `${PREFIX}-part`,
      unitPricePaise: 64000,
      validFrom: new Date('2031-01-01T00:00:00.000Z'),
    },
  });
  await prismaBase.calloutFee.create({
    data: {
      id: `${PREFIX}-callout-standard`,
      priceListId: PUBLIC_NOW,
      serviceType: 'STANDARD',
      feePaise: 30000,
      validFrom: new Date('2031-01-01T00:00:00.000Z'),
    },
  });

  // A job that is already running when its list expires.
  await prismaBase.job.upsert({
    where: { id: `${PREFIX}-job-midflight` },
    update: { priceListId: PUBLIC_NOW, createdAt: IN_NOW },
    create: {
      id: `${PREFIX}-job-midflight`,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      priceListId: PUBLIC_NOW,
      status: 'WORKING',
      safetyLevel: 'NORMAL',
      createdAt: IN_NOW,
      lat: 12.9352,
      lng: 77.6245,
    },
  });
}

// The tenant, zone, driver and vehicle every test here hangs off. Upserted
// rather than rebuilt: unlike the price lists, nothing in this file changes
// them, and other rows (jobs from earlier runs) point at them.
async function buildActors(): Promise<void> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Pricing Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'PRC',
      name: 'Pricing Zone',
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
      // Named so nothing else can collide: `vehicle_profiles` is unique on
      // (make, model, year_from, year_to) and the database is shared.
      make: 'Pricing Motors',
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
  await prismaBase.partCategory.upsert({
    where: { id: `${PREFIX}-category` },
    update: {},
    create: { id: `${PREFIX}-category`, code: `${PREFIX.toUpperCase()}-CAT`, name: 'Pricing Fixture Parts' },
  });
  await prismaBase.part.upsert({
    where: { id: `${PREFIX}-part` },
    update: {},
    create: {
      id: `${PREFIX}-part`,
      sku: `${PREFIX.toUpperCase()}-BELT`,
      name: 'Fixture drive belt',
      categoryId: `${PREFIX}-category`,
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
      registration: 'KA01PC0001',
      colour: 'Green',
    },
  });
}
