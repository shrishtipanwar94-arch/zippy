// A DEMO DRIVER: their login, the driver row, the tenant membership, and their
// car. Used twice by ensureDemoBoard — for the presenter's driver (who signs
// in) and for the reference job's driver (who never does, see
// prisma/seed/demoReferenceJob.ts). Upserted on natural keys: email, user,
// (tenant, user) and registration.

import type { PrismaClient } from '@prisma/client';
import { DEMO_TENANT_ID, DEMO_ZONE } from '../../src/demo/demoCrews.js';

export type DemoDriverSeed = {
  userId: string;
  driverId: string;
  membershipId: string;
  vehicleId: string;
  email: string;
  name: string;
  registration: string;
};

// UPSERT ON THE PROFILE'S NATURAL KEY. The main seed may already hold a
// MARUTI_SUZUKI Swift 2018-2024, and `vehicle_profiles` is unique on
// (make, model, yearFrom, yearTo) — creating one by id would collide.
async function swiftProfileId(db: PrismaClient): Promise<string> {
  const profileKey = { make: 'MARUTI_SUZUKI', model: 'Swift', yearFrom: 2018, yearTo: 2024 };
  const profile = await db.vehicleProfile.upsert({
    where: { make_model_yearFrom_yearTo: profileKey },
    update: {},
    create: { id: 'demo-profile', ...profileKey, bodyType: 'HATCHBACK', fuelType: 'PETROL', keyType: 'SMART' },
    select: { id: true },
  });
  return profile.id;
}

export async function seedDemoDriver(db: PrismaClient, seed: DemoDriverSeed, passwordHash: string): Promise<void> {
  const user = await db.user.upsert({
    where: { email: seed.email },
    update: { passwordHash, name: seed.name },
    create: { id: seed.userId, email: seed.email, passwordHash, role: 'DRIVER', name: seed.name },
    select: { id: true },
  });

  const driver = await db.driver.upsert({
    where: { userId: user.id },
    update: {},
    create: { id: seed.driverId, userId: user.id, tenantId: DEMO_TENANT_ID, homeZoneId: DEMO_ZONE.id },
    select: { id: true },
  });

  // THE MEMBERSHIP IS WHAT PUTS A TENANT IN THE TOKEN, and `Driver.tenantId`
  // is not. `resolveTenantBinding` (src/api/auth.ts) reads `user.memberships`
  // at login; with none, every tenant-scoped read fails closed and the driver
  // signs in to find they own no vehicles.
  await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: DEMO_TENANT_ID, userId: user.id } },
    update: { role: 'DRIVER' },
    create: { id: seed.membershipId, tenantId: DEMO_TENANT_ID, userId: user.id, role: 'DRIVER' },
  });

  const profileId = await swiftProfileId(db);
  await db.vehicle.upsert({
    where: { registration: seed.registration },
    update: { profileId },
    create: {
      id: seed.vehicleId,
      driverId: driver.id,
      tenantId: DEMO_TENANT_ID,
      profileId,
      registration: seed.registration,
      colour: 'White',
    },
  });
}
