/**
 * THE SMALLEST BOARD ON WHICH A REAL DISPATCH FULLY SUCCEEDS.
 *
 * One zone, one dispatcher, one driver, one technician, one van. Enough for a
 * flat battery to be reported, planned, offered and accepted end to end, and
 * deliberately nothing more.
 *
 * WHY IT IS A SEPARATE FILE AND NOT A FLAG ON THE MAIN SEED. prisma/seed.ts
 * builds a deliberately HARD board — 24 units, 31 technicians, an uneven
 * capability matrix — because that is what the evaluation harness measures and
 * what the test suites are written against. Both depend on its exact shape, so
 * it is not something to parameterise. This file is a second, independent
 * entry point (`npm run db:seed:demo`); it never imports prisma/seed.ts and
 * nothing in prisma/seed.ts imports it.
 *
 * WHAT IT DOES REUSE is the four lookup tables — capabilities, the parts
 * catalogue, prices, the intake question catalogue — and the platform ledger
 * accounts. Those are vocabulary, not fleet: re-declaring twelve capability
 * codes here would be a second copy to keep in step with src/domain/faults.ts,
 * and the first copy drifting is how a demo board silently stops matching the
 * engine.
 *
 * TIME IS RELATIVE TO NOW, NOT TO A SEEDED DATE. The technician's shift starts
 * an hour ago and ends eight hours from now, and the van's stock was counted
 * just now. This is the whole reason the file exists in this shape: a shift
 * written as a clock time goes stale the next day, every unit then fails
 * NO_TECHNICIAN_ON_SHIFT, and the board fills with jobs nothing can be sent
 * to. Re-running this seeder is what moves the window, so "it stopped working
 * overnight" is answered by running it again.
 *
 * NO WORKSHOP, ON PURPOSE. A destination leg is only required when the
 * contending faults need a tow (TOW_CAPABILITY_CODES in
 * src/domain/capabilitySet.ts). A flat battery is fixed at the roadside, so
 * seeding a workshop would add a row nothing in this demo reads. Verify with
 * `npx tsx scripts/demo-dry-check.ts`, which prints the required capability
 * set the classifier actually produced.
 */

import type { PrismaClient } from '@prisma/client';
import { prisma } from './client.js';
import { DEV_PASSWORD_HASH } from './devPassword.js';
import { seedCapabilities } from './capabilities.js';
import { seedParts } from './parts.js';
import { seedPricing } from './pricing.js';
import { seedIntakeQuestions } from './intakeQuestions.js';
import { seedLedgerAccounts } from './ledgerAccounts.js';

// Every row this file owns carries this prefix, so a demo board is always
// distinguishable from the main seed's and re-running is a genuine no-op.
const ZONE = 'demo-zone';
const TENANT = 'demo-tenant';
const TECHNICIAN = 'demo-technician';
const UNIT = 'demo-unit';
const DRIVER = 'demo-driver';
const VEHICLE = 'demo-vehicle';
const PROFILE = 'demo-profile';

// WHAT THE CREW CAN DO, and why these three and not one.
//
// A flat battery alone needs only JUMP_START. But intake does not hand dispatch
// one fault — it hands it a distribution, and `requiredCapabilities` takes
// every fault down to 80% of the probability mass (src/domain/capabilitySet.ts).
// A "will not start, battery warning light" answer set realistically contends
// between a flat battery, a failed one and a starter motor, so a crew holding
// only JUMP_START would be rejected CAPABILITY_MISSING the moment the driver's
// answers were slightly less clean than the script.
//
// NO TOW CAPABILITY, deliberately: see the file header on why there is no
// workshop.
const CREW_CAPABILITIES = ['JUMP_START', 'BATTERY_REPLACEMENT', 'OBD_DIAGNOSTICS'];

// The part a FAILED_BATTERY would need. A flat battery needs none
// (PARTS_BY_FAULT in src/domain/faults.ts), so this is cover for the wider
// distribution above rather than something the happy path reads.
const STOCKED_SKU = 'BAT-45AH';

const SHIFT_STARTED_HOURS_AGO = 1;
const SHIFT_ENDS_IN_HOURS = 8;

// Koramangala — the same centroid the main seed's first zone uses, so the
// coordinates fall inside the Bengaluru OSRM extract and real road travel
// times work when the container is up.
const CENTRE = { lat: 12.9352, lng: 77.6245 };

async function seedZone(db: PrismaClient): Promise<void> {
  await db.zone.upsert({
    where: { id: ZONE },
    update: {},
    create: {
      id: ZONE,
      code: 'DMO',
      name: 'Demo Zone',
      city: 'Bengaluru',
      centroidLat: CENTRE.lat,
      centroidLng: CENTRE.lng,
      boundary: { type: 'bbox', minLat: 12.9, maxLat: 12.97, minLng: 77.59, maxLng: 77.66 },
    },
  });
}

async function seedTenantAndStaff(db: PrismaClient): Promise<void> {
  await db.tenant.upsert({
    where: { id: TENANT },
    update: {},
    // CONSUMER, with no contract behind it. That is one less thing to seed and
    // one less filter to satisfy: with no SLA policy the job's
    // `slaResponseMinutes` is null, so SLA_UNREACHABLE cannot fire at all.
    create: { id: TENANT, name: 'Demo Walk-ins', kind: 'CONSUMER' },
  });

  await db.user.upsert({
    where: { email: 'demo-dispatcher@zippy.internal' },
    update: { passwordHash: DEV_PASSWORD_HASH, name: 'Demo Dispatcher' },
    create: {
      id: 'demo-user-dispatcher',
      email: 'demo-dispatcher@zippy.internal',
      passwordHash: DEV_PASSWORD_HASH,
      role: 'DISPATCHER',
      name: 'Demo Dispatcher',
    },
  });
}

async function seedDriverAndVehicle(db: PrismaClient): Promise<void> {
  await db.user.upsert({
    where: { email: 'demo-driver@zippy.internal' },
    update: { passwordHash: DEV_PASSWORD_HASH, name: 'Asha Rao' },
    create: {
      id: 'demo-user-driver',
      email: 'demo-driver@zippy.internal',
      passwordHash: DEV_PASSWORD_HASH,
      role: 'DRIVER',
      name: 'Asha Rao',
    },
  });

  await db.driver.upsert({
    where: { id: DRIVER },
    update: {},
    create: { id: DRIVER, userId: 'demo-user-driver', tenantId: TENANT, homeZoneId: ZONE },
  });

  // THE MEMBERSHIP IS WHAT PUTS A TENANT IN THE TOKEN, and `Driver.tenantId`
  // is not. `resolveTenantBinding` (src/api/auth.ts) reads `user.memberships`
  // at login; with none, the token carries `tenantId: null`, and
  // `tenantFilterValue` then scopes every tenant-scoped read to a tenant id
  // that cannot exist — which fails closed, so the driver signs in fine and
  // then owns no vehicles. Found exactly that way: `GET /vehicles` returned an
  // empty list for a driver whose one vehicle was sitting in the table.
  await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: TENANT, userId: 'demo-user-driver' } },
    update: { role: 'DRIVER' },
    create: { id: 'demo-membership-driver', tenantId: TENANT, userId: 'demo-user-driver', role: 'DRIVER' },
  });
}

async function seedVehicle(db: PrismaClient): Promise<void> {
  // UPSERT ON THE NATURAL KEY, NOT ON AN ID WE CHOSE. `vehicle_profiles` is
  // unique on (make, model, yearFrom, yearTo), and the main seed already holds
  // a MARUTI_SUZUKI Swift 2018-2024 — so creating this by id collides the first
  // time the demo seeder is run on a database the main seed has touched. Keyed
  // on the natural key it reuses that row when it exists and creates its own
  // after a reset, which is the same answer either way: one profile for this
  // make and model.
  const profile = await db.vehicleProfile.upsert({
    where: {
      make_model_yearFrom_yearTo: {
        make: 'MARUTI_SUZUKI',
        model: 'Swift',
        yearFrom: 2018,
        yearTo: 2024,
      },
    },
    update: {},
    create: {
      id: PROFILE,
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

  await db.vehicle.upsert({
    where: { id: VEHICLE },
    update: { profileId: profile.id },
    create: {
      id: VEHICLE,
      driverId: DRIVER,
      tenantId: TENANT,
      profileId: profile.id,
      registration: 'KA01DM0001',
      colour: 'White',
    },
  });
}

async function seedTechnician(db: PrismaClient): Promise<void> {
  await db.user.upsert({
    where: { email: 'demo-tech@zippy.internal' },
    // A REAL FIRST NAME, because the driver is shown one. `headlineFor` says
    // "<first name> is on the way", so a technician called "Demo Technician"
    // has the driver's most reassuring sentence read "Demo is on the way."
    update: { passwordHash: DEV_PASSWORD_HASH, name: 'Ravi Kumar' },
    create: {
      id: 'demo-user-tech',
      email: 'demo-tech@zippy.internal',
      passwordHash: DEV_PASSWORD_HASH,
      role: 'TECHNICIAN',
      name: 'Ravi Kumar',
    },
  });

  await db.technician.upsert({
    where: { id: TECHNICIAN },
    update: { active: true },
    create: {
      id: TECHNICIAN,
      userId: 'demo-user-tech',
      employeeCode: 'DMO-T1',
      homeZoneId: ZONE,
      active: true,
    },
  });
}

async function seedVan(db: PrismaClient, now: Date): Promise<void> {
  await db.unit.upsert({
    where: { id: UNIT },
    // AVAILABLE on every re-run: a demo left halfway through has this van HELD
    // or ON_JOB, and the next run has to put it back or the only unit on the
    // board fails UNIT_UNAVAILABLE.
    //
    // DO NOT RUN THIS SEEDER IN THE MIDDLE OF A LIVE DEMO. Forcing the van back
    // to AVAILABLE does not close the job it was on, so the job stays COMMITTED
    // with this unit assigned while the unit is free to be held again — and the
    // next dispatch puts a SECOND active job on it, which is invariant 7
    // ("one active job per unit") broken by the fixture rather than by the
    // product. Observed exactly that way while verifying this seed: two holds
    // 46 seconds apart, both CONSUMED, because a re-seed landed between them.
    // Starting over means `scripts/demo-reset.sh`, which drops the database.
    update: { status: 'AVAILABLE', zoneId: ZONE, currentTechnicianId: TECHNICIAN },
    create: {
      id: UNIT,
      code: 'DMO-V1',
      kind: 'VAN',
      zoneId: ZONE,
      status: 'AVAILABLE',
      currentTechnicianId: TECHNICIAN,
      lat: CENTRE.lat,
      lng: CENTRE.lng,
      lastLocationAt: now,
    },
  });
}

// THIS FILE OWNS BOTH CAPABILITY SETS, so it clears them before granting.
//
// `upsert({ where, update: {}, create })` on a join table ADDS a link and never
// removes one, which makes it append-only rather than idempotent: a capability
// granted by an earlier version of this seeder would survive every later run
// and quietly widen what the demo crew can do. Phase 13 lost an afternoon to
// exactly this. A seeder that means "these are the capabilities" rather than
// "add this one" has to delete first.
async function grantCapabilities(db: PrismaClient): Promise<void> {
  const capabilities = await db.capability.findMany({
    where: { code: { in: CREW_CAPABILITIES } },
    select: { id: true, code: true },
  });
  if (capabilities.length !== CREW_CAPABILITIES.length) {
    const found = capabilities.map((capability) => capability.code);
    const missing = CREW_CAPABILITIES.filter((code) => !found.includes(code));
    throw new Error(`capability codes missing from the catalogue: ${missing.join(', ')}`);
  }

  await db.technicianCapability.deleteMany({ where: { technicianId: TECHNICIAN } });
  await db.unitCapability.deleteMany({ where: { unitId: UNIT } });

  for (const capability of capabilities) {
    await db.technicianCapability.create({
      data: { technicianId: TECHNICIAN, capabilityId: capability.id },
    });
    await db.unitCapability.create({
      data: { unitId: UNIT, capabilityId: capability.id },
    });
  }
}

// THE SHIFT, RELATIVE TO NOW. One row per run, replaced rather than added to —
// two overlapping shifts for one technician is a state the main seed takes care
// to avoid and the duty toggle (src/commit/technicianDuty.ts) reads the latest.
async function openShift(db: PrismaClient, now: Date): Promise<void> {
  await db.technicianShift.deleteMany({ where: { technicianId: TECHNICIAN } });
  await db.technicianShift.create({
    data: {
      technicianId: TECHNICIAN,
      zoneId: ZONE,
      startsAt: new Date(now.getTime() - SHIFT_STARTED_HOURS_AGO * 60 * 60_000),
      endsAt: new Date(now.getTime() + SHIFT_ENDS_IN_HOURS * 60 * 60_000),
    },
  });
}

// COUNTED JUST NOW, which is the point. Stock whose count has aged out reads
// UNVERIFIED, and src/engine/partSourcing.ts counts UNVERIFIED as ABSENT —
// failing closed, so a stale count is indistinguishable from an empty van.
async function stockTheVan(db: PrismaClient, now: Date): Promise<void> {
  const part = await db.part.findFirst({ where: { sku: STOCKED_SKU }, select: { id: true } });
  if (!part) throw new Error(`part ${STOCKED_SKU} is not in the catalogue`);

  const existing = await db.unitStock.findFirst({
    where: { unitId: UNIT, partId: part.id },
    select: { id: true },
  });
  if (existing) {
    await db.unitStock.update({
      where: { id: existing.id },
      data: { quantity: 2, startingQty: 2, confirmedAt: now },
    });
    return;
  }
  await db.unitStock.create({
    data: { unitId: UNIT, partId: part.id, quantity: 2, startingQty: 2, confirmedAt: now },
  });
}

async function seedDemo(): Promise<void> {
  const now = new Date();

  // The four lookup tables and the platform ledger, in the same order
  // prisma/seed.ts uses them: prices need parts.
  await seedCapabilities(prisma);
  await seedParts(prisma);
  await seedPricing(prisma);
  await seedIntakeQuestions(prisma);
  await seedLedgerAccounts(prisma);

  await seedZone(prisma);
  await seedTenantAndStaff(prisma);
  await seedDriverAndVehicle(prisma);
  await seedVehicle(prisma);
  await seedTechnician(prisma);
  await seedVan(prisma, now);
  await grantCapabilities(prisma);
  await openShift(prisma, now);
  await stockTheVan(prisma, now);

  const shift = await prisma.technicianShift.findFirstOrThrow({
    where: { technicianId: TECHNICIAN },
    select: { startsAt: true, endsAt: true },
  });

  // eslint-disable-next-line no-console
  console.log(
    'demo board seeded: 1 zone, 1 dispatcher, 1 driver, 1 technician crewing 1 van\n' +
      `  crew can do: ${CREW_CAPABILITIES.join(', ')}\n` +
      `  shift: ${shift.startsAt.toISOString()} -> ${shift.endsAt.toISOString()}\n` +
      '  next: npx tsx scripts/demo-dry-check.ts',
  );
}

seedDemo()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
