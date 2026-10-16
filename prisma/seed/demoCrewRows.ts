// ONE DEMO CREW: the technician's login, the technician, their unit, and what
// the pair can do. Called once per entry in DEMO_CREWS (src/demo/demoCrews.ts)
// by ensureDemoBoard in prisma/seed/demoBoard.ts.
//
// UPSERTS ON NATURAL KEYS — email, employee code, unit code — so this runs on
// every boot of the web process without creating a second copy of anything.
// The ids in DEMO_CREWS are only used when a row is created for the first time.

import type { PrismaClient } from '@prisma/client';
import type { DemoCrew } from '../../src/demo/demoCrews.js';
import { DEMO_ZONE } from '../../src/demo/demoCrews.js';
import { DEV_PASSWORD_HASH, unusablePasswordHash } from './devPassword.js';

type SeededCrew = { technicianId: string; unitId: string };

async function seedTechnician(db: PrismaClient, crew: DemoCrew): Promise<string> {
  // Only crew B can sign in. A, C and D get a password nobody knows, re-rolled
  // on every boot, so their accounts exist (a technician row needs a user) but
  // cannot be used and are never listed (src/api/loginAccounts.ts).
  const passwordHash = crew.canSignIn ? DEV_PASSWORD_HASH : unusablePasswordHash();
  const user = await db.user.upsert({
    where: { email: crew.email },
    update: { passwordHash, name: crew.name },
    create: {
      id: crew.userId,
      email: crew.email,
      passwordHash,
      role: 'TECHNICIAN',
      name: crew.name,
    },
    select: { id: true },
  });

  const technician = await db.technician.upsert({
    where: { employeeCode: crew.employeeCode },
    update: { active: true, homeZoneId: DEMO_ZONE.id },
    create: {
      id: crew.technicianId,
      userId: user.id,
      employeeCode: crew.employeeCode,
      homeZoneId: DEMO_ZONE.id,
      active: true,
    },
    select: { id: true },
  });
  return technician.id;
}

// The unit is created on the first boot and, on every later boot, put back
// where the demo needs it: AVAILABLE, at home, crewed. A demo left halfway
// leaves a van HELD or somewhere else, and the next presenter should not
// inherit that. A BUSY van is never passed here — see findBusyUnitIds.
async function seedUnit(db: PrismaClient, crew: DemoCrew, technicianId: string, now: Date): Promise<string> {
  const home = { lat: crew.lat, lng: crew.lng, lastLocationAt: now };
  const unit = await db.unit.upsert({
    where: { code: crew.unitCode },
    // The kind is updated too: it is part of what the crew IS (a van cannot
    // tow), and a board seeded by an earlier version must not keep the old one.
    update: {
      status: 'AVAILABLE',
      kind: crew.unitKind,
      zoneId: DEMO_ZONE.id,
      currentTechnicianId: technicianId,
      ...home,
    },
    create: {
      id: crew.unitId,
      code: crew.unitCode,
      kind: crew.unitKind,
      zoneId: DEMO_ZONE.id,
      status: 'AVAILABLE',
      currentTechnicianId: technicianId,
      ...home,
    },
    select: { id: true },
  });
  return unit.id;
}

// THIS FILE OWNS BOTH CAPABILITY SETS, so it clears them before granting.
//
// `upsert({ where, update: {}, create })` on a join table ADDS a link and never
// removes one, which makes it append-only rather than idempotent: a capability
// granted by an earlier version of this seed would survive every later run and
// quietly widen what a demo crew can do. Phase 13 lost an afternoon to exactly
// this (CLAUDE.md, GOTCHAS). For a demo whose whole point is that A CANNOT
// replace a battery, a leftover grant would silently remove the lesson.
async function grantCapabilities(db: PrismaClient, crew: DemoCrew, seeded: SeededCrew): Promise<void> {
  const capabilities = await db.capability.findMany({
    where: { code: { in: crew.capabilities } },
    select: { id: true, code: true },
  });
  if (capabilities.length !== crew.capabilities.length) {
    const found = capabilities.map((capability) => capability.code);
    const missing = crew.capabilities.filter((code) => !found.includes(code));
    throw new Error(`capability codes missing from the catalogue: ${missing.join(', ')}`);
  }

  await db.technicianCapability.deleteMany({ where: { technicianId: seeded.technicianId } });
  await db.unitCapability.deleteMany({ where: { unitId: seeded.unitId } });

  for (const capability of capabilities) {
    await db.technicianCapability.create({
      data: { technicianId: seeded.technicianId, capabilityId: capability.id },
    });
    await db.unitCapability.create({
      data: { unitId: seeded.unitId, capabilityId: capability.id },
    });
  }
}

// `busyUnitCodes` are vans on a live job: their login and technician row are
// still kept current, but the unit and its capabilities are not touched.
export async function seedDemoCrew(
  db: PrismaClient,
  crew: DemoCrew,
  busyUnitCodes: Set<string>,
  now: Date,
): Promise<void> {
  const technicianId = await seedTechnician(db, crew);
  if (busyUnitCodes.has(crew.unitCode)) return;

  const unitId = await seedUnit(db, crew, technicianId, now);
  await grantCapabilities(db, crew, { technicianId, unitId });
}
