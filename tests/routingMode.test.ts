// HAVERSINE IS THE PRODUCTION DEFAULT, OSRM EVERYWHERE ELSE, and a declared
// ROUTING_MODE always wins (chooseRoutingMode in src/infra/config.ts).
//
// Pinned because the two defaults protect different things: production runs
// without an OSRM service and must not spend OSRM_TIMEOUT_MS discovering that
// on every call, while development and the suites keep real road routes.

import { describe, expect, it } from 'vitest';
import { chooseRoutingMode } from '../src/infra/config.js';

describe('chooseRoutingMode', () => {
  it('defaults to HAVERSINE in production', () => {
    expect(chooseRoutingMode(undefined, 'production')).toBe('HAVERSINE');
  });

  it('defaults to OSRM in development and test', () => {
    expect(chooseRoutingMode(undefined, 'development')).toBe('OSRM');
    expect(chooseRoutingMode(undefined, 'test')).toBe('OSRM');
  });

  it('lets a declared ROUTING_MODE override the default either way', () => {
    expect(chooseRoutingMode('OSRM', 'production')).toBe('OSRM');
    expect(chooseRoutingMode('HAVERSINE', 'development')).toBe('HAVERSINE');
  });
});
