// Six zones across one city — Bengaluru. Phase 6 seeds all zones inside a
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
  { code: 'KOR', name: 'Koramangala', lat: 12.9352, lng: 77.6245 },
  { code: 'IND', name: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
  { code: 'WHF', name: 'Whitefield', lat: 12.9698, lng: 77.7499 },
  { code: 'JAY', name: 'Jayanagar', lat: 12.9299, lng: 77.5833 },
  { code: 'HEB', name: 'Hebbal', lat: 13.0358, lng: 77.597 },
  { code: 'ELC', name: 'Electronic City', lat: 12.8452, lng: 77.6602 },
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
        city: 'Bengaluru',
        centroidLat: zone.lat,
        centroidLng: zone.lng,
        boundary: boundingBox(zone.lat, zone.lng),
      },
      create: {
        id: `zone-${zone.code.toLowerCase()}`,
        code: zone.code,
        name: zone.name,
        city: 'Bengaluru',
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
