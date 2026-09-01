/**
 * Seeds a deliberately hard dispatch board: six zones in one city, 24 units
 * across four kinds, 31 technicians with an UNEVEN capability matrix (two EV
 * certifications, three key programmers, eighteen OBD, everyone on the basics),
 * partially overlapping shifts, twelve workshops, ~20 parts with stock and
 * prices, one active price list, and four tenants (one GOLD fleet, two SILVER,
 * walk-in consumers).
 *
 * Every seeder upserts on a deterministic id, so running this twice — or a
 * hundred times — changes nothing and never errors. That is the whole contract
 * of a seed: safe to run again.
 *
 * Order matters. Each step below references ids the earlier steps create.
 */

import { prisma } from './seed/client.js';
import { seedZones } from './seed/zones.js';
import { seedCapabilities } from './seed/capabilities.js';
import { seedParts } from './seed/parts.js';
import { seedPricing } from './seed/pricing.js';
import { seedTenants } from './seed/tenants.js';
import { seedTechnicians } from './seed/technicians.js';
import { seedFleet } from './seed/fleet.js';
import { seedWorkshops } from './seed/workshops.js';
import { seedDepots } from './seed/depots.js';
import { seedDrivers } from './seed/drivers.js';
import { seedIntakeQuestions } from './seed/intakeQuestions.js';
import { seedCrews } from './seed/crews.js';
import { seedLedgerAccounts } from './seed/ledgerAccounts.js';
import { seedVanCounts } from './seed/vanCounts.js';

async function seed(): Promise<void> {
  await seedZones(prisma);
  await seedCapabilities(prisma);
  await seedParts(prisma);
  await seedPricing(prisma); // needs parts
  await seedTenants(prisma); // tiers, contracts, SLA, staff logins
  await seedTechnicians(prisma); // needs zones + capabilities
  await seedFleet(prisma); // needs zones + capabilities + parts
  await seedWorkshops(prisma); // needs zones
  await seedDepots(prisma); // needs zones
  await seedDrivers(prisma); // needs tenants
  await seedIntakeQuestions(prisma); // projection of src/domain/questions.ts
  await seedCrews(prisma); // needs units + technicians
  await seedLedgerAccounts(prisma); // the platform's three; technician accounts are made on first use
  await seedVanCounts(prisma); // needs unit stock; stamps how long ago each van was counted

  const [zones, units, technicians, workshops, depots, evCertified, crewed] = await Promise.all([
    prisma.zone.count(),
    prisma.unit.count(),
    prisma.technician.count(),
    prisma.workshop.count(),
    prisma.depot.count(),
    prisma.technicianCapability.count({ where: { capability: { code: 'EV_HV_CERTIFICATION' } } }),
    prisma.unit.count({ where: { currentTechnicianId: { not: null } } }),
  ]);

  console.log(
    `seeded: ${zones} zones, ${units} units, ${technicians} technicians, ` +
      `${workshops} workshops, ${depots} depots, ${evCertified} EV-certified technicians, ` +
      `${crewed}/${units} units crewed`,
  );
}

seed()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
