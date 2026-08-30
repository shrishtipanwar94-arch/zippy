// SELF-HOSTED ROUTING — real road travel time, computed locally, never a
// hosted maps API.
//
// WHY OSRM AND NOT GOOGLE MAPS OR MAPBOX.
// Invariant 10: nothing the solver depends on may call out to an external
// service, because that is what makes a seeded evaluation run reproducible.
// A hosted routing API can answer the same request differently between two
// calls — a changed traffic model, a re-routed road, a rate limit swapped for
// a degraded response — and two runs of `npm run eval` with the same seed
// would then score differently for a reason that has nothing to do with the
// dispatch policy being evaluated. That silently destroys the one claim this
// project rests on: that a policy change can be measured. OSRM, run locally
// against a fixed map extract, answers the same coordinates with the same
// number every time, for as long as the extract does not change — which is
// this project's own choice, not a third party's.
//
// It also makes carriageway direction REAL rather than hand-waved. OSRM's
// routing graph is built from OpenStreetMap's actual road segments, which
// already encode one-way restrictions and highway dividers as separate,
// directional ways. Asking OSRM for a route from a unit to a job therefore
// automatically respects "the unit is on the wrong carriageway and has to
// reach the next interchange to turn around" — no bespoke carriageway math is
// needed in this file or in src/engine/candidates.ts, because the road graph
// already knows. Haversine distance cannot express this at all: two points
// 200m apart in a straight line and 20km apart by road look identical to it.
//
// OSRM COORDINATE ORDER IS (LONGITUDE, LATITUDE) — the opposite of every other
// coordinate pair in this codebase (Job.lat/lng, Zone.centroidLat/Lng are
// always lat-then-lng). Getting this backwards does not error; OSRM will
// often still find SOME route, just to the wrong place on Earth, which is a
// far worse failure than a crash. Every function here takes a `LatLng` object
// and converts it to OSRM's order in exactly one place (`osrmCoordinate`),
// never inline at a call site.
//
// FALLBACK: if OSRM is unreachable or fails, this returns a haversine-based
// estimate instead of throwing — a routing hiccup must not take down intake
// or candidate generation. But it is never silently substituted: every result
// carries `degraded: true` in that case (invariant 8, every degraded state is
// visible to an operator), and the fallback cannot know about one-way roads
// or dividers at all, which is exactly the gap real routing exists to close.

import { config } from './config.js';
import { distanceKm } from '../domain/geo.js';
import { logger } from './logger.js';

export type LatLng = { lat: number; lng: number };

export type TravelTimeEstimate = {
  minutes: number;
  method: 'OSRM' | 'HAVERSINE_FALLBACK';
  // Mirrors `method === 'HAVERSINE_FALLBACK'`, kept as its own boolean rather
  // than making every caller compare strings — this is the field invariant 8
  // actually cares about.
  degraded: boolean;
};

function osrmCoordinate(point: LatLng): string {
  return `${point.lng},${point.lat}`;
}

function haversineFallback(from: LatLng, to: LatLng): TravelTimeEstimate {
  const roadKm = distanceKm(from.lat, from.lng, to.lat, to.lng) * config.ROUTING_FALLBACK_ROAD_FACTOR;
  const minutes = (roadKm / config.ROUTING_FALLBACK_SPEED_KMH) * 60;
  return { minutes, method: 'HAVERSINE_FALLBACK', degraded: true };
}

// Both public functions take the OSRM base URL as their last argument,
// defaulting to config.OSRM_URL — an explicit parameter instead of always
// reading the shared config directly, so a test can point one call at an
// address nothing listens on without touching global state to do it.
type BaseUrl = string;

// A hung OSRM (container starting, or genuinely stuck) must not hang a
// dispatch decision — OSRM_TIMEOUT_MS bounds how long this ever waits before
// treating it the same as unreachable.
async function fetchOsrm(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.OSRM_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type OsrmRouteResponse = { code: string; routes?: { duration: number }[] };

// ONE-TO-ONE, via OSRM's /route endpoint. `overview=false` — no route
// geometry is requested, because nothing here draws a map; asking for it
// would just be a larger response to throw away.
export async function travelTime(
  from: LatLng,
  to: LatLng,
  baseUrl: BaseUrl = config.OSRM_URL,
): Promise<TravelTimeEstimate> {
  try {
    const url =
      `${baseUrl}/route/v1/driving/${osrmCoordinate(from)};${osrmCoordinate(to)}` + '?overview=false';
    const response = await fetchOsrm(url);
    if (!response.ok) throw new Error(`OSRM /route responded ${response.status}`);

    const body = (await response.json()) as OsrmRouteResponse;
    const route = body.routes?.[0];
    if (body.code !== 'Ok' || !route) throw new Error(`OSRM could not find a route: ${body.code}`);

    return { minutes: route.duration / 60, method: 'OSRM', degraded: false };
  } catch (error) {
    logger.warn({ err: error }, 'OSRM /route unreachable or failed — falling back to haversine');
    return haversineFallback(from, to);
  }
}

type OsrmTableResponse = { code: string; durations?: (number | null)[][] };

// MANY-TO-ONE, via OSRM's /table endpoint — one HTTP round trip for every
// candidate unit's time to the job, instead of N separate /route calls.
// src/engine/candidates.ts uses this rather than calling `travelTime` in a
// loop.
export async function travelTimeMatrix(
  origins: LatLng[],
  destination: LatLng,
  baseUrl: BaseUrl = config.OSRM_URL,
): Promise<TravelTimeEstimate[]> {
  if (origins.length === 0) return [];

  try {
    // The destination is appended as the LAST coordinate; `sources` names
    // every index before it, `destinations` names only that last one — OSRM's
    // /table is many-to-many by default and this is how you ask for
    // many-to-one instead.
    const coordinates = [...origins, destination].map(osrmCoordinate).join(';');
    const sources = origins.map((_, index) => index).join(';');
    const destinationIndex = origins.length;
    const url =
      `${baseUrl}/table/v1/driving/${coordinates}` +
      `?sources=${sources}&destinations=${destinationIndex}&annotations=duration`;

    const response = await fetchOsrm(url);
    if (!response.ok) throw new Error(`OSRM /table responded ${response.status}`);

    const body = (await response.json()) as OsrmTableResponse;
    if (body.code !== 'Ok' || !body.durations) {
      throw new Error(`OSRM could not build a table: ${body.code}`);
    }

    return body.durations.map((row, index) => {
      const seconds = row[0];
      // OSRM returns null for one pair it could not connect through the road
      // graph (an origin on an unconnected fragment of the map) even when the
      // rest of the table succeeded. That failure belongs to THAT ONE origin,
      // not the whole batch — only it falls back, not every unit in the fleet.
      if (seconds === null || seconds === undefined) {
        logger.warn({ origin: origins[index] }, 'OSRM found no route for this origin — falling back to haversine');
        return haversineFallback(origins[index]!, destination);
      }
      return { minutes: seconds / 60, method: 'OSRM', degraded: false };
    });
  } catch (error) {
    logger.warn(
      { err: error, count: origins.length },
      'OSRM /table unreachable or failed — falling back to haversine for the whole batch',
    );
    return origins.map((origin) => haversineFallback(origin, destination));
  }
}
