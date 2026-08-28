// Twenty-four units across the four kinds. Units are equipped generously — the
// binding constraint in a scarcity scenario is a certified *technician*, not
// the van — but the tow kinds and the EV/key vans still differ, so capability
// resolution has something real to chew on.
//
//   12 VAN            general service, carry a parts kit
//    6 BIKE           fast response: jump / tyre / fuel / lockout only, no tow
//    4 FLATBED_TOW    recovery + flatbed loading
//    2 WHEEL_LIFT_TOW recovery, lighter tow

import type { PrismaClient, UnitKind } from '@prisma/client';
import { capabilityId } from './capabilities.js';
import { partId } from './parts.js';
import { ZONES, zoneId } from './zones.js';

type UnitPlan = { kind: UnitKind; count: number };

const UNIT_PLAN: UnitPlan[] = [
  { kind: 'VAN', count: 12 },
  { kind: 'BIKE', count: 6 },
  { kind: 'FLATBED_TOW', count: 4 },
  { kind: 'WHEEL_LIFT_TOW', count: 2 },
];

// vanIndex is 0-based within the twelve vans, so the EV and key-programming
// vans are a small minority, mirroring the technician scarcity.
function vanCapabilities(vanIndex: number): string[] {
  const codes = ['JUMP_START', 'TYRE_CHANGE', 'FUEL_DELIVERY', 'LOCKOUT', 'OBD_DIAGNOSTICS', 'BATTERY_REPLACEMENT'];
  if (vanIndex < 6) codes.push('BRAKE_REPAIR', 'ALTERNATOR_REPLACEMENT');
  if (vanIndex < 3) codes.push('KEY_PROGRAMMING');
  if (vanIndex < 2) codes.push('EV_HV_CERTIFICATION');
  return codes;
}

function capabilitiesFor(kind: UnitKind, indexWithinKind: number): string[] {
  if (kind === 'VAN') return vanCapabilities(indexWithinKind);
  if (kind === 'BIKE') return ['JUMP_START', 'TYRE_CHANGE', 'FUEL_DELIVERY', 'LOCKOUT'];
  if (kind === 'FLATBED_TOW') return ['JUMP_START', 'TYRE_CHANGE', 'WINCH_RECOVERY', 'FLATBED_LOADING'];
  return ['JUMP_START', 'TYRE_CHANGE', 'WINCH_RECOVERY']; // WHEEL_LIFT_TOW
}

// The standard on-board stock for each kind: SKU -> quantity.
function stockFor(kind: UnitKind, indexWithinKind: number): Record<string, number> {
  if (kind === 'VAN') {
    const kit: Record<string, number> = {
      'BAT-45AH': 1,
      'BAT-65AH': 1,
      'TYRE-REPAIR-KIT': 2,
      'BRK-PAD-FRONT': 1,
      'BRK-FLUID-DOT4': 2,
      'FUSE-ASSORTED': 5,
      'BULB-H4': 4,
      'OIL-5W30-4L': 3,
      'COOLANT-5L': 2,
      'WIPER-PAIR': 2,
      'SPARK-PLUG-SET': 2,
      'DRIVE-BELT': 1,
      'JUMP-LEAD-HEAVY': 1,
    };
    if (indexWithinKind < 3) kit['KEY-FOB-BLANK'] = 3;
    return kit;
  }
  if (kind === 'BIKE') {
    return { 'PETROL-5L': 2, 'FUSE-ASSORTED': 3, 'BULB-H4': 2, 'JUMP-LEAD-HEAVY': 1 };
  }
  return { 'TOW-STRAP-5T': 1, 'JUMP-LEAD-HEAVY': 1 }; // both tow kinds
}

export async function seedFleet(prisma: PrismaClient): Promise<void> {
  let globalIndex = 0;

  for (const plan of UNIT_PLAN) {
    for (let withinKind = 0; withinKind < plan.count; withinKind++) {
      const number = String(globalIndex + 1).padStart(2, '0');
      const unitId = `unit-${number}`;
      const zone = ZONES[globalIndex % ZONES.length]!;
      const home = zoneId(globalIndex);

      // Place the unit a little off the zone centroid so map markers do not
      // all stack on one point.
      const jitter = (globalIndex % 5) * 0.004;

      await prisma.unit.upsert({
        where: { code: unitId.toUpperCase() },
        update: { kind: plan.kind, zoneId: home, status: 'AVAILABLE' },
        create: {
          id: unitId,
          code: unitId.toUpperCase(),
          kind: plan.kind,
          zoneId: home,
          status: 'AVAILABLE',
          lat: zone.lat + jitter,
          lng: zone.lng - jitter,
          lastLocationAt: new Date(),
        },
      });

      for (const code of capabilitiesFor(plan.kind, withinKind)) {
        const capId = capabilityId(code);
        await prisma.unitCapability.upsert({
          where: { unitId_capabilityId: { unitId, capabilityId: capId } },
          update: {},
          create: { id: `unitcap-${number}-${code.toLowerCase()}`, unitId, capabilityId: capId },
        });
      }

      const stock = stockFor(plan.kind, withinKind);
      for (const [sku, quantity] of Object.entries(stock)) {
        const pId = partId(sku);
        await prisma.unitStock.upsert({
          where: { unitId_partId: { unitId, partId: pId } },
          update: { quantity },
          create: { id: `stock-${number}-${sku.toLowerCase()}`, unitId, partId: pId, quantity },
        });
      }

      globalIndex++;
    }
  }
}
