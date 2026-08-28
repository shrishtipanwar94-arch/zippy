// The capability catalogue. Skills a technician can hold and a unit can be
// equipped for; dispatch later resolves a job against the intersection of the
// two. Scarcity of the specialist codes is the whole point of the seed — see
// technicians.ts for the deliberately uneven assignment.

import type { PrismaClient } from '@prisma/client';

type CapabilitySeed = {
  code: string;
  name: string;
  category: string;
  description: string;
};

export const CAPABILITIES: CapabilitySeed[] = [
  { code: 'JUMP_START', name: 'Battery jump-start', category: 'BASIC', description: 'Boost a flat battery to start the vehicle.' },
  { code: 'TYRE_CHANGE', name: 'Tyre change', category: 'BASIC', description: 'Fit the spare or a loaner wheel.' },
  { code: 'FUEL_DELIVERY', name: 'Emergency fuel delivery', category: 'BASIC', description: 'Deliver enough fuel to reach a station.' },
  { code: 'LOCKOUT', name: 'Vehicle lockout entry', category: 'BASIC', description: 'Non-destructive entry for a locked-out driver.' },
  { code: 'OBD_DIAGNOSTICS', name: 'OBD-II fault diagnosis', category: 'DIAGNOSTIC', description: 'Read and interpret engine-management fault codes.' },
  { code: 'BATTERY_REPLACEMENT', name: 'Battery replacement', category: 'REPAIR', description: 'Swap a failed battery, including stop-start types.' },
  { code: 'ALTERNATOR_REPLACEMENT', name: 'Alternator replacement', category: 'REPAIR', description: 'Roadside alternator swap where access allows.' },
  { code: 'BRAKE_REPAIR', name: 'Roadside brake repair', category: 'REPAIR', description: 'Pads, fluid and bleeding for a car that cannot drive.' },
  { code: 'KEY_PROGRAMMING', name: 'Transponder key programming', category: 'SPECIALIST', description: 'Program a replacement transponder or smart key.' },
  { code: 'EV_HV_CERTIFICATION', name: 'EV high-voltage systems', category: 'SPECIALIST', description: 'Certified to work on live high-voltage EV systems.' },
  { code: 'WINCH_RECOVERY', name: 'Winch / off-road recovery', category: 'RECOVERY', description: 'Recover a vehicle that is stuck or off the carriageway.' },
  { code: 'FLATBED_LOADING', name: 'Flatbed load and secure', category: 'RECOVERY', description: 'Load and strap a vehicle onto a flatbed for towing.' },
];

export async function seedCapabilities(prisma: PrismaClient): Promise<void> {
  for (const capability of CAPABILITIES) {
    await prisma.capability.upsert({
      where: { code: capability.code },
      update: {
        name: capability.name,
        category: capability.category,
        description: capability.description,
      },
      create: {
        id: `cap-${capability.code.toLowerCase()}`,
        code: capability.code,
        name: capability.name,
        category: capability.category,
        description: capability.description,
      },
    });
  }
}

export function capabilityId(code: string): string {
  return `cap-${code.toLowerCase()}`;
}
