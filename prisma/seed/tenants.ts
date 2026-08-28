// Four tenants: one GOLD fleet, two SILVER fleets, and walk-in consumers.
// Consumers are modelled as a tenant too (kind CONSUMER) so every job has a
// tenant and tenant scoping in Phase 2 has no special case. Fleet tenants get
// a contract, an SLA policy and a fleet-manager login; the consumer tenant
// pays per callout and has none of that.
//
// Passwords here are placeholders — Phase 2 introduces argon2id hashing and
// real credentials. The string is obviously not a hash on purpose.

import type { PrismaClient } from '@prisma/client';
import { START_OF_YEAR } from './client.js';

const PLACEHOLDER_HASH = 'seed-placeholder-not-a-real-hash';

const TIERS: { id: string; name: 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE'; priority: number; description: string }[] = [
  { id: 'tier-gold', name: 'GOLD', priority: 30, description: 'Fastest response, highest priority in the queue.' },
  { id: 'tier-silver', name: 'SILVER', priority: 20, description: 'Standard fleet response.' },
  { id: 'tier-bronze', name: 'BRONZE', priority: 10, description: 'Best-effort fleet response.' },
  { id: 'tier-none', name: 'NONE', priority: 0, description: 'No contract — walk-in, pay per callout.' },
];

type FleetSeed = {
  id: string;
  name: string;
  tierId: string;
  responseMinutes: number;
  resolutionMinutes: number;
  managerEmail: string;
  managerName: string;
};

const FLEETS: FleetSeed[] = [
  {
    id: 'tenant-metrocab',
    name: 'MetroCab Fleet',
    tierId: 'tier-gold',
    responseMinutes: 30,
    resolutionMinutes: 90,
    managerEmail: 'fm-metrocab@zippy.internal',
    managerName: 'MetroCab Fleet Manager',
  },
  {
    id: 'tenant-citylogistics',
    name: 'CityLogistics',
    tierId: 'tier-silver',
    responseMinutes: 45,
    resolutionMinutes: 120,
    managerEmail: 'fm-city@zippy.internal',
    managerName: 'CityLogistics Fleet Manager',
  },
  {
    id: 'tenant-quickmove',
    name: 'QuickMove Rentals',
    tierId: 'tier-silver',
    responseMinutes: 45,
    resolutionMinutes: 120,
    managerEmail: 'fm-quick@zippy.internal',
    managerName: 'QuickMove Fleet Manager',
  },
];

async function seedTiers(prisma: PrismaClient): Promise<void> {
  for (const tier of TIERS) {
    await prisma.contractTier.upsert({
      where: { id: tier.id },
      update: { priority: tier.priority, description: tier.description },
      create: { id: tier.id, name: tier.name, priority: tier.priority, description: tier.description },
    });
  }
}

async function seedFleetTenant(prisma: PrismaClient, fleet: FleetSeed): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: fleet.id },
    update: { name: fleet.name },
    create: { id: fleet.id, name: fleet.name, kind: 'FLEET' },
  });

  const contractId = `contract-${fleet.id}`;
  await prisma.contract.upsert({
    where: { id: contractId },
    update: { active: true, tierId: fleet.tierId },
    create: {
      id: contractId,
      tenantId: fleet.id,
      tierId: fleet.tierId,
      name: `${fleet.name} service contract`,
      startsAt: START_OF_YEAR,
      active: true,
    },
  });

  // One SLA policy per service type. Highway work gets a tighter window
  // because a stranded vehicle on a highway is the dangerous case.
  const slaPolicies = [
    { suffix: 'standard', serviceType: 'STANDARD', response: fleet.responseMinutes, resolution: fleet.resolutionMinutes },
    { suffix: 'highway', serviceType: 'HIGHWAY', response: Math.round(fleet.responseMinutes * 0.7), resolution: Math.round(fleet.resolutionMinutes * 0.8) },
  ];
  for (const policy of slaPolicies) {
    const id = `sla-${fleet.id}-${policy.suffix}`;
    await prisma.slaPolicy.upsert({
      where: { id },
      update: { responseMinutes: policy.response, resolutionMinutes: policy.resolution },
      create: {
        id,
        contractId,
        serviceType: policy.serviceType,
        responseMinutes: policy.response,
        resolutionMinutes: policy.resolution,
      },
    });
    await prisma.coveredService.upsert({
      where: { contractId_serviceType: { contractId, serviceType: policy.serviceType } },
      update: { covered: true },
      create: { id: `covered-${fleet.id}-${policy.suffix}`, contractId, serviceType: policy.serviceType, covered: true },
    });
  }

  const managerUserId = `user-${fleet.id}-fm`;
  await prisma.user.upsert({
    where: { email: fleet.managerEmail },
    update: { name: fleet.managerName },
    create: {
      id: managerUserId,
      email: fleet.managerEmail,
      passwordHash: PLACEHOLDER_HASH,
      role: 'FLEET_MANAGER',
      name: fleet.managerName,
    },
  });
  await prisma.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: fleet.id, userId: managerUserId } },
    update: { role: 'FLEET_MANAGER' },
    create: { id: `membership-${fleet.id}-fm`, tenantId: fleet.id, userId: managerUserId, role: 'FLEET_MANAGER' },
  });
}

async function seedConsumerTenant(prisma: PrismaClient): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: 'tenant-walkin' },
    update: { name: 'Walk-in Consumers' },
    create: { id: 'tenant-walkin', name: 'Walk-in Consumers', kind: 'CONSUMER' },
  });
}

async function seedDispatcher(prisma: PrismaClient): Promise<void> {
  // The dispatcher belongs to no tenant and may read across all of them
  // (every cross-tenant read is audited, from Phase 2).
  await prisma.user.upsert({
    where: { email: 'dispatch-ops@zippy.internal' },
    update: { name: 'Dispatch Operations' },
    create: {
      id: 'user-dispatcher',
      email: 'dispatch-ops@zippy.internal',
      passwordHash: PLACEHOLDER_HASH,
      role: 'DISPATCHER',
      name: 'Dispatch Operations',
    },
  });
}

export async function seedTenants(prisma: PrismaClient): Promise<void> {
  await seedTiers(prisma);
  for (const fleet of FLEETS) {
    await seedFleetTenant(prisma, fleet);
  }
  await seedConsumerTenant(prisma);
  await seedDispatcher(prisma);
}
