// Six zones across one city — Delhi. All inside the NCT on purpose: the
// OSRM extract (scripts/setup-osrm.sh) is Geofabrik's India northern zone,
// which stops at the Uttar Pradesh border, so a zone in Ghaziabad or Noida
// would be routed on an almost empty road graph. Phase 6 seeds all zones inside a
// single OSRM extract, so keeping them in one real city matters later. Each
// zone carries a centroid (used to place units and workshops near it) and a
// rough bounding box as its boundary.

import type { PrismaClient } from '@prisma/client';

type ZoneSeed = {
  code: string;
  name: string;
  lat: number;
  lng: number;
};

// Real-ish centroids so road distances between zones are plausible when OSRM
// arrives. Order is fixed — other seeders round-robin over ZONES by index.
export const ZONES: ZoneSeed[] = [
  { code: 'CNP', name: 'Connaught Place', lat: 28.6152, lng: 77.2095 },
  { code: 'CHC', name: 'Chandni Chowk', lat: 28.6519, lng: 77.2262 },
  { code: 'PVR', name: 'Preet Vihar', lat: 28.6417, lng: 77.295 },
  { code: 'DHK', name: 'Dhaula Kuan', lat: 28.6099, lng: 77.1683 },
  { code: 'MDT', name: 'Model Town', lat: 28.7158, lng: 77.182 },
  { code: 'KLK', name: 'Kalkaji', lat: 28.5252, lng: 77.2452 },
];

function boundingBox(lat: number, lng: number) {
  const pad = 0.03; // ~3km — enough to look like a service area on the map
  return {
    type: 'bbox',
    minLat: lat - pad,
    maxLat: lat + pad,
    minLng: lng - pad,
    maxLng: lng + pad,
  };
}

export async function seedZones(prisma: PrismaClient): Promise<void> {
  for (const zone of ZONES) {
    await prisma.zone.upsert({
      where: { code: zone.code },
      update: {
        name: zone.name,
        city: 'Delhi',
        centroidLat: zone.lat,
        centroidLng: zone.lng,
        boundary: boundingBox(zone.lat, zone.lng),
      },
      create: {
        id: `zone-${zone.code.toLowerCase()}`,
        code: zone.code,
        name: zone.name,
        city: 'Delhi',
        centroidLat: zone.lat,
        centroidLng: zone.lng,
        boundary: boundingBox(zone.lat, zone.lng),
      },
    });
  }
}

export function zoneId(index: number): string {
  const zone = ZONES[index % ZONES.length];
  return `zone-${zone!.code.toLowerCase()}`;
}
