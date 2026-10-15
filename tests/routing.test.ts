// src/infra/routing.ts: real OSRM road time, respecting carriageway direction
// where haversine cannot, and the degraded fallback when OSRM is not there.
//
// TWO GROUPS. `haversine fallback` needs no infrastructure at all — it is
// pure arithmetic and runs whether or not OSRM is up. `against a real OSRM`
// needs the container actually serving the preprocessed Delhi map
// (scripts/setup-osrm.sh, then `docker compose up -d osrm`) and skips itself
// with a clear message if it is not reachable, the same shape as the
// concurrency suite needing a real Postgres — a property about ACTUAL road
// geometry cannot be asserted against a stand-in for one.

import { describe, expect, it } from 'vitest';
import { travelTime, travelTimeMatrix } from '../src/infra/routing.js';
import { config } from '../src/infra/config.js';

// A port nothing listens on, passed as the explicit base-url argument both
// routing functions take — no global config mutation needed to simulate OSRM
// being unreachable.
const UNREACHABLE = 'http://localhost:1';

describe('haversine fallback — no infrastructure required', () => {
  it('estimates a plausible time from distance alone when OSRM cannot be reached', async () => {
    // Connaught Place to Chandni Chowk, roughly 5km apart.
    const result = await travelTime(
      { lat: 28.6152, lng: 77.2095 },
      { lat: 28.6519, lng: 77.2262 },
      UNREACHABLE,
    );

    expect(result.method).toBe('HAVERSINE_FALLBACK');
    expect(result.degraded).toBe(true);
    expect(result.minutes).toBeGreaterThan(0);
  });

  it('is flagged DEGRADED — never silently substituted for a real route', async () => {
    const result = await travelTime(
      { lat: 28.6152, lng: 77.2095 },
      { lat: 28.6519, lng: 77.2262 },
      UNREACHABLE,
    );

    // The whole point of invariant 8: a caller can tell this apart from a
    // real route without knowing OSRM exists at all.
    expect(result.degraded).toBe(true);
  });

  it('falls back for an entire batch through travelTimeMatrix, one estimate per origin', async () => {
    const origins = [
      { lat: 28.6152, lng: 77.2095 },
      { lat: 28.6099, lng: 77.1683 },
    ];
    const destination = { lat: 28.6519, lng: 77.2262 };

    const results = await travelTimeMatrix(origins, destination, UNREACHABLE);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.degraded)).toBe(true);
  });

  it('returns no estimates for no origins, without making a request', async () => {
    const results = await travelTimeMatrix([], { lat: 28.6152, lng: 77.2095 });
    expect(results).toEqual([]);
  });

  it('scales with the configured road factor and assumed speed', async () => {
    const from = { lat: 28.6152, lng: 77.2095 };
    const to = { lat: 28.6519, lng: 77.2262 };
    const result = await travelTime(from, to, UNREACHABLE);

    // The fallback's own formula, recomputed independently — this is the one
    // test that would catch the road factor or speed constant being
    // accidentally applied in the wrong place (e.g. multiplying minutes
    // instead of kilometres).
    const straightLineKmApprox = 5.4; // Connaught Place-Chandni Chowk, roughly
    const roughMinutes =
      ((straightLineKmApprox * config.ROUTING_FALLBACK_ROAD_FACTOR) / config.ROUTING_FALLBACK_SPEED_KMH) * 60;
    expect(result.minutes).toBeGreaterThan(roughMinutes * 0.5);
    expect(result.minutes).toBeLessThan(roughMinutes * 1.5);
  });
});

// CHECKED AT MODULE LOAD, NOT INSIDE A HOOK. `it.skipIf()`'s condition is read
// while vitest COLLECTS this file's tests, which happens before any
// `beforeAll` has had a chance to run — a boolean only a hook resolves is
// still `false`, its unset default, at the moment `.skipIf` reads it, and
// every test in the group is skipped regardless of the real answer. A
// top-level `await` runs before collection continues, so by the time
// `describe` below executes, `osrmAvailable` already holds the real result.
let osrmAvailable = false;
try {
  const response = await fetch(
    `${config.OSRM_URL}/route/v1/driving/77.2095,28.6152;77.2262,28.6519?overview=false`,
  );
  const body = (await response.json()) as { code?: string };
  osrmAvailable = response.ok && body.code === 'Ok';
} catch {
  osrmAvailable = false;
}
if (!osrmAvailable) {
  console.warn(
    `\n  SKIPPING real-OSRM tests: no OSRM reachable at ${config.OSRM_URL}. ` +
      'Run scripts/setup-osrm.sh once, then `docker compose up -d osrm`.\n',
  );
}

describe('against a real OSRM', () => {
  it.skipIf(!osrmAvailable)('returns a real road time, not degraded, for two connected points', async () => {
    const result = await travelTime({ lat: 28.6152, lng: 77.2095 }, { lat: 28.6519, lng: 77.2262 });

    expect(result.method).toBe('OSRM');
    expect(result.degraded).toBe(false);
    expect(result.minutes).toBeGreaterThan(0);
  });

  // THE CHECK BLOCK'S OWN ASSERTION. Two real points on Delhi's Outer Ring
  // Road, on opposite carriageways of the same divided stretch about 4km west
  // of Model Town — one of the seeded zones. 14 metres apart in a straight
  // line; found by scanning the extract for pairs of opposing one-way ways
  // with the same name, keeping pairs where each point snaps to its own
  // carriageway, and taking the one with the longest road detour (10 minutes).
  // (Before the move to Delhi this test used two points on Bengaluru's Outer
  // Ring Road, chosen the same way.) Reaching the
  // other carriageway means driving to wherever the road's median actually
  // opens, which haversine has no way to know exists at all.
  const carriagewayA = { lat: 28.7117346, lng: 77.1376656 };
  const carriagewayB = { lat: 28.7116822, lng: 77.1378002 };
  const STRAIGHT_LINE_KM = 0.014;

  it.skipIf(!osrmAvailable)(
    'a road time across a divided highway is far larger than the straight-line time would suggest',
    async () => {
      const result = await travelTime(carriagewayA, carriagewayB);

      expect(result.method).toBe('OSRM');
      const straightLineMinutesIfDirect = (STRAIGHT_LINE_KM / config.ROUTING_FALLBACK_SPEED_KMH) * 60;
      // The real road route is dramatically longer than even driving the
      // 14m straight-line distance at a crawl — because it is not 14m by
      // road at all; it is the length of the whole one-way stretch to the
      // nearest place to turn around.
      expect(result.minutes).toBeGreaterThan(straightLineMinutesIfDirect * 20);
    },
  );

  it.skipIf(!osrmAvailable)(
    'travelTimeMatrix agrees with travelTime for the same pair, within rounding',
    async () => {
      const single = await travelTime(carriagewayA, carriagewayB);
      const batch = await travelTimeMatrix([carriagewayA], carriagewayB);

      expect(batch).toHaveLength(1);
      expect(batch[0]!.minutes).toBeCloseTo(single.minutes, 1);
    },
  );
});
