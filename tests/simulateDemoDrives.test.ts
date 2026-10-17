// THE DEMO VAN'S SIMULATED DRIVE (src/demo/simulateDemoDrives.ts).
//
// One step moves the van the right distance straight towards the car, and the
// last step lands exactly on the car rather than overshooting it — a dot that
// sails past the driver and back would make the map lie in the other direction.

import { describe, expect, it } from 'vitest';
import { stepTowards } from '../src/demo/simulateDemoDrives.js';
import { distanceKm } from '../src/domain/geo.js';

const GOLE_MARKET = { lat: 28.63, lng: 77.2 };
const CONNAUGHT_PLACE = { lat: 28.6152, lng: 77.2095 };

describe('stepTowards', () => {
  it('moves the van the step distance along the straight line to the car', () => {
    const before = distanceKm(GOLE_MARKET.lat, GOLE_MARKET.lng, CONNAUGHT_PLACE.lat, CONNAUGHT_PLACE.lng);
    const next = stepTowards(GOLE_MARKET, CONNAUGHT_PLACE, 0.1);
    const after = distanceKm(next.lat, next.lng, CONNAUGHT_PLACE.lat, CONNAUGHT_PLACE.lng);

    expect(next.arrived).toBe(false);
    expect(before - after).toBeCloseTo(0.1, 2);
  });

  it('lands exactly on the car when the car is closer than one step', () => {
    const near = { lat: CONNAUGHT_PLACE.lat + 0.0003, lng: CONNAUGHT_PLACE.lng };
    expect(stepTowards(near, CONNAUGHT_PLACE, 0.1)).toEqual({ ...CONNAUGHT_PLACE, arrived: true });
  });

  it('reaches the car in a sensible number of ten-second ticks at city speed', () => {
    const stepKm = (30 * 10_000) / 3_600_000;
    let at = GOLE_MARKET;
    let ticks = 0;
    for (; ticks < 200; ticks++) {
      const next = stepTowards(at, CONNAUGHT_PLACE, stepKm);
      at = next;
      if (next.arrived) break;
    }
    // ~1.9 km at 30 km/h is about four minutes: roughly 23 ticks.
    expect(ticks).toBeGreaterThan(15);
    expect(ticks).toBeLessThan(30);
  });
});
