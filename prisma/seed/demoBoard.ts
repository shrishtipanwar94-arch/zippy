// ENSURE THE DEMO BOARD EXISTS, AND IS READY TO DISPATCH.
//
// One zone, one dispatcher, one driver with a car, and the four crews in
// src/demo/demoCrews.ts. Safe to run on every boot of the web process
// (DEMO_MODE=true, see scripts/start-process.sh) and by hand
// (`npm run db:seed:demo`): every write is an upsert on a natural key, and the
// sets this file owns (capabilities, shifts) are replaced rather than added to.
//
// WHY IT IS NOT A FLAG ON THE MAIN SEED. prisma/seed.ts builds a deliberately
// HARD board — 24 units, 31 technicians, an uneven capability matrix — because
// that is what the evaluation harness measures and the test suites are written
// against. Both depend on its exact shape. This file never imports
// prisma/seed.ts and nothing in prisma/seed.ts imports it.
//
// WHAT IT DOES REUSE is the lookup tables — capabilities, the parts catalogue,
// prices, the intake question catalogue — and the platform ledger accounts.
// Those are vocabulary, not fleet: a second copy of twelve capability codes
// here would drift from src/domain/faults.ts, and the first sign would be a
// demo crew silently failing CAPABILITY_MISSING.
//
// NO WORKSHOP, ON PURPOSE. A destination is only needed when the contending
// faults need a tow, and a flat battery is fixed at the roadside.

import type { PrismaClient } from '@prisma/client';
import { DEV_PASSWORD_HASH } from './devPassword.js';
import { seedCapabilities } from './capabilities.js';
import { seedParts } from './parts.js';
import { seedPricing } from './pricing.js';
import { seedIntakeQuestions } from './intakeQuestions.js';
import { seedLedgerAccounts } from './ledgerAccounts.js';
import { seedDemoCrew } from './demoCrewRows.js';
import { findBusyUnitIds } from '../../src/demo/busyDemoUnits.js';
import { refreshDemoShifts } from '../../src/demo/refreshDemoShifts.js';
import { refreshDemoStock } from '../../src/demo/refreshDemoStock.js';
import {
  DEMO_CREWS,
  DEMO_DISPATCHER,
  DEMO_DRIVER,
  DEMO_DRIVER_LOCATION,
  DEMO_TENANT_ID,
  DEMO_ZONE,
} from '../../src/demo/demoCrews.js';

export type DemoBoardSummary = {
  crewsReady: number;
  // Unit codes left untouched because they are on a live job.
  busyUnitCodes: string[];
};

async function seedZoneAndTenant(db: PrismaClient): Promise<void> {
  // The boundary and centroid are UPDATED, not just created: they are this
  // file's to own, and a seed change that never reached an existing board
  // would leave crew D outside its own zone.
  const geometry = {
    centroidLat: DEMO_DRIVER_LOCATION.lat,
    centroidLng: DEMO_DRIVER_LOCATION.lng,
    boundary: DEMO_ZONE.boundary,
  };
  await db.zone.upsert({
    where: { code: DEMO_ZONE.code },
    update: geometry,
    create: {
      id: DEMO_ZONE.id,
      code: DEMO_ZONE.code,
      name: DEMO_ZONE.name,
      city: 'Delhi',
      ...geometry,
    },
  });

  // CONSUMER, with no contract behind it: no SLA policy means the job's
  // `slaResponseMinutes` is null, so SLA_UNREACHABLE cannot fire at all.
  await db.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {},
    create: { id: DEMO_TENANT_ID, name: 'Demo Walk-ins', kind: 'CONSUMER' },
  });

  await db.user.upsert({
    where: { email: DEMO_DISPATCHER.email },
    update: { passwordHash: DEV_PASSWORD_HASH, name: DEMO_DISPATCHER.name },
    create: {
      id: DEMO_DISPATCHER.userId,
      email: DEMO_DISPATCHER.email,
      passwordHash: DEV_PASSWORD_HASH,
      role: 'DISPATCHER',
      name: DEMO_DISPATCHER.name,
    },
  });
}

async function seedDriver(db: PrismaClient): Promise<void> {
  const user = await db.user.upsert({
    where: { email: DEMO_DRIVER.email },
    update: { passwordHash: DEV_PASSWORD_HASH, name: DEMO_DRIVER.name },
    create: {
      id: DEMO_DRIVER.userId,
      email: DEMO_DRIVER.email,
      passwordHash: DEV_PASSWORD_HASH,
      role: 'DRIVER',
      name: DEMO_DRIVER.name,
    },
    select: { id: true },
  });

  const driver = await db.driver.upsert({
    where: { userId: user.id },
    update: {},
    create: { id: DEMO_DRIVER.driverId, userId: user.id, tenantId: DEMO_TENANT_ID, homeZoneId: DEMO_ZONE.id },
    select: { id: true },
  });

  // THE MEMBERSHIP IS WHAT PUTS A TENANT IN THE TOKEN, and `Driver.tenantId`
  // is not. `resolveTenantBinding` (src/api/auth.ts) reads `user.memberships`
  // at login; with none, every tenant-scoped read fails closed and the driver
  // signs in to find they own no vehicles.
  await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: DEMO_TENANT_ID, userId: user.id } },
    update: { role: 'DRIVER' },
    create: { id: DEMO_DRIVER.membershipId, tenantId: DEMO_TENANT_ID, userId: user.id, role: 'DRIVER' },
  });

  // UPSERT ON THE PROFILE'S NATURAL KEY. The main seed may already hold a
  // MARUTI_SUZUKI Swift 2018-2024, and `vehicle_profiles` is unique on
  // (make, model, yearFrom, yearTo) — creating one by id would collide.
  const profileKey = { make: 'MARUTI_SUZUKI', model: 'Swift', yearFrom: 2018, yearTo: 2024 };
  const profile = await db.vehicleProfile.upsert({
    where: { make_model_yearFrom_yearTo: profileKey },
    update: {},
    create: { id: DEMO_DRIVER.profileId, ...profileKey, bodyType: 'HATCHBACK', fuelType: 'PETROL', keyType: 'SMART' },
    select: { id: true },
  });

  await db.vehicle.upsert({
    where: { registration: DEMO_DRIVER.registration },
    update: { profileId: profile.id },
    create: {
      id: DEMO_DRIVER.vehicleId,
      driverId: driver.id,
      tenantId: DEMO_TENANT_ID,
      profileId: profile.id,
      registration: DEMO_DRIVER.registration,
      colour: 'White',
    },
  });
}

async function findBusyUnitCodes(db: PrismaClient): Promise<Set<string>> {
  const existing = await db.unit.findMany({
    where: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } },
    select: { id: true, code: true },
  });
  const busyIds = await findBusyUnitIds(db, existing.map((unit) => unit.id));
  const busyCodes = new Set<string>();
  for (const unit of existing) {
    if (busyIds.has(unit.id)) busyCodes.add(unit.code);
  }
  return busyCodes;
}

export async function ensureDemoBoard(db: PrismaClient, now: Date = new Date()): Promise<DemoBoardSummary> {
  // Read BEFORE anything is written, so a van on a live job is recognised as
  // busy from the state the presenter left it in.
  const busyUnitCodes = await findBusyUnitCodes(db);

  // Prices need parts, so this is the order prisma/seed.ts uses too.
  await seedCapabilities(db);
  await seedParts(db);
  await seedPricing(db);
  await seedIntakeQuestions(db);
  await seedLedgerAccounts(db);

  await seedZoneAndTenant(db);
  await seedDriver(db);

  for (const crew of DEMO_CREWS) {
    await seedDemoCrew(db, crew, busyUnitCodes, now);
  }

  // The same two functions the worker runs every fifteen minutes, so there is
  // one definition of "on shift" and "counted" for a demo crew, not two.
  const refreshedTechnicians = await refreshDemoShifts(db, now);
  await refreshDemoStock(db, now);

  return { crewsReady: refreshedTechnicians.length, busyUnitCodes: [...busyUnitCodes] };
}
