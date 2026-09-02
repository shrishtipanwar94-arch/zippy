// Twelve workshops, two per zone. Each carries brand authorisations, an EV
// class flag (null / LV / HV) and opening hours — read for real from Phase 22
// (src/engine/destinationSelection.ts). Two workshops run 24x7; the rest are
// Mon-Sat daytime.

import type { PrismaClient } from '@prisma/client';
import { ZONES } from './zones.js';

type WorkshopSeed = {
  suffix: string;
  name: string;
  evClass: string | null;
  brands: string[];
  capabilities: string[];
  around: boolean; // 24x7
};

const BRANDS = ['MARUTI_SUZUKI', 'HYUNDAI', 'TATA', 'MAHINDRA', 'TOYOTA', 'HONDA', 'KIA', 'VOLKSWAGEN'];

// Two workshops per zone; index 0..11 across all zones.
function planFor(index: number): WorkshopSeed {
  const evClass = index === 2 || index === 7 ? 'HV' : index % 4 === 1 ? 'LV' : null;
  const brands = [BRANDS[index % BRANDS.length]!, BRANDS[(index + 3) % BRANDS.length]!];
  const capabilities = ['GENERAL_REPAIR', 'BRAKES'];
  if (index % 2 === 0) capabilities.push('ENGINE_REPAIR');
  if (evClass === 'HV') capabilities.push('EV_HV_SERVICE');
  if (evClass === 'LV') capabilities.push('EV_LV_SERVICE');
  return {
    suffix: index % 2 === 0 ? 'a' : 'b',
    name: `${index % 2 === 0 ? 'Prime' : 'CityLine'} Auto Works`,
    evClass,
    brands,
    capabilities,
    around: index === 0 || index === 6,
  };
}

async function seedHours(prisma: PrismaClient, workshopId: string, around: boolean): Promise<void> {
  for (let day = 0; day < 7; day++) {
    const closedSunday = day === 0 && !around;
    await prisma.workshopHours.upsert({
      where: { workshopId_dayOfWeek: { workshopId, dayOfWeek: day } },
      update: {
        opens: around ? '00:00' : '09:00',
        closes: around ? '24:00' : '19:00',
        closed: closedSunday,
      },
      create: {
        id: `hours-${workshopId}-${day}`,
        workshopId,
        dayOfWeek: day,
        opens: around ? '00:00' : '09:00',
        closes: around ? '24:00' : '19:00',
        closed: closedSunday,
      },
    });
  }
}

export async function seedWorkshops(prisma: PrismaClient): Promise<void> {
  for (let index = 0; index < 12; index++) {
    const zone = ZONES[Math.floor(index / 2)]!;
    const plan = planFor(index);
    const code = `WS-${zone.code}-${plan.suffix.toUpperCase()}`;
    const workshopId = `workshop-${code.toLowerCase()}`;

    await prisma.workshop.upsert({
      where: { code },
      update: { name: `${plan.name} ${zone.name}`, evClass: plan.evClass, active: true },
      create: {
        id: workshopId,
        code,
        name: `${plan.name} ${zone.name}`,
        zoneId: `zone-${zone.code.toLowerCase()}`,
        lat: zone.lat + 0.008,
        lng: zone.lng + 0.008,
        evClass: plan.evClass,
        active: true,
      },
    });

    for (const brand of plan.brands) {
      await prisma.workshopAuthorisation.upsert({
        where: { workshopId_brand: { workshopId, brand } },
        update: { level: 'STANDARD' },
        create: { id: `wsauth-${workshopId}-${brand.toLowerCase()}`, workshopId, brand, level: 'STANDARD' },
      });
    }

    for (const capabilityCode of plan.capabilities) {
      await prisma.workshopCapability.upsert({
        where: { workshopId_capabilityCode: { workshopId, capabilityCode } },
        update: {},
        create: { id: `wscap-${workshopId}-${capabilityCode.toLowerCase()}`, workshopId, capabilityCode },
      });
    }

    await seedHours(prisma, workshopId, plan.around);
  }
}
