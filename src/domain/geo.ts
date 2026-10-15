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
// HOW FAR FROM A ZONE CENTROID IS STILL US.
//
// `nearestZone` answers "which of our zones is closest", and for a long time
// that was taken as an answer to "which zone is this job in". It is not: with
// no upper bound the nearest zone to ANY coordinate is one of ours. When the
// zones were in Bengaluru, a driver in Delhi was 1,742km from the nearest one
// and intake filed the job there anyway — silently, into zone-heb, where it
// sat in the queue looking exactly like a job somebody could be sent to. Every
// earlier coordinate had come from a simulator that only generates points in
// the seeded city, so nothing had ever tested the assumption. (The zones have
// since moved to Delhi; the rule is the same in any city.)
//
// 80km, and the number is measured rather than picked. The seeded zone
// centroids span 22.1km corner to corner, so 80 covers the metro and a wide
// margin of ring road and satellite towns around it while still being an order
// of magnitude short of the next city. It is a SERVICE-AREA rule, not a
// geometry one: a fleet that opens a second city adds zones, and this number
// keeps meaning "near one of our zones" without being touched.
//
// Deliberately generous. The cost of rejecting a real customer at the edge of
// coverage is far higher than the cost of accepting one 70km out and telling a
// dispatcher the travel time is long.
export const SERVICE_AREA_RADIUS_KM = 80;

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
