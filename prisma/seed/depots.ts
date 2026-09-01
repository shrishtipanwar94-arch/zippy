// THREE DEPOTS — where a van goes to be filled up.
//
// Deliberately few, and deliberately dumb. A depot in this system is an
// address a restock happens at; there is no ordering, no supplier, no lead
// time and no inventory of its own. Phase 18 says so explicitly, and the
// reason is that a depot with stock levels is a second copy of the whole
// inventory problem, on top of a routing problem, to serve a phase whose real
// subject is the confidence of a van's count.
//
// They exist now because Phase 19 prices a workshop or depot run as a source
// of parts inside candidate generation, and a coordinate it can measure a
// detour to has to be in the database before that arithmetic can be written.

import type { PrismaClient } from '@prisma/client';

type DepotSeed = { code: string; name: string; zoneCode: string; lat: number; lng: number };

// One in the south, one in the east, one in the north — so no zone is more
// than a plausible cross-town run from a depot, and the three are far enough
// apart that "the nearest one" is a real choice rather than a formality.
export const DEPOTS: DepotSeed[] = [
  { code: 'DEP-KOR', name: 'Koramangala depot', zoneCode: 'KOR', lat: 12.9312, lng: 77.6285 },
  { code: 'DEP-WHF', name: 'Whitefield depot', zoneCode: 'WHF', lat: 12.9742, lng: 77.7462 },
  { code: 'DEP-HEB', name: 'Hebbal depot', zoneCode: 'HEB', lat: 13.0391, lng: 77.5931 },
];

export async function seedDepots(prisma: PrismaClient): Promise<void> {
  for (const depot of DEPOTS) {
    await prisma.depot.upsert({
      where: { code: depot.code },
      update: { name: depot.name, lat: depot.lat, lng: depot.lng },
      create: {
        id: `depot-${depot.code.toLowerCase()}`,
        code: depot.code,
        name: depot.name,
        zoneId: `zone-${depot.zoneCode.toLowerCase()}`,
        lat: depot.lat,
        lng: depot.lng,
      },
    });
  }
}
