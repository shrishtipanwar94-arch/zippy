// Straight-line distance between two points, and nothing else.
//
// Used at intake to pick the zone a breakdown belongs to. It is deliberately
// NOT a travel time: road distance arrives in Phase 6 with a self-hosted OSRM,
// and until then a zone assignment is an administrative label, not a dispatch
// decision. Invariant 10 — nothing in a decision path may call out — is safe
// here either way, because this is local arithmetic with no network at all.

// HAVERSINE
// Latitude and longitude are angles on a sphere, so you cannot subtract them
// and use Pythagoras. Haversine is the standard closed form for great-circle
// distance: convert both points to radians, and the formula below returns the
// arc length between them. Accurate to a few metres at city scale, which is far
// finer than anything this uses it for.

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function distanceKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(toRadians(fromLat)) *
      Math.cos(toRadians(toLat)) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export type ZoneCentroid = {
  id: string;
  centroidLat: number;
  centroidLng: number;
};

// The zone whose centroid is closest. Ties break on zone id so the choice is
// deterministic — the Phase 10 harness replays these runs.
export function nearestZone<T extends ZoneCentroid>(zones: T[], lat: number, lng: number): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const zone of zones) {
    const distance = distanceKm(lat, lng, zone.centroidLat, zone.centroidLng);
    if (distance < bestDistance || (distance === bestDistance && best !== null && zone.id < best.id)) {
      best = zone;
      bestDistance = distance;
    }
  }

  return best;
}
