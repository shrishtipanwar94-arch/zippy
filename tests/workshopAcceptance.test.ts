// src/domain/workshopAcceptance.ts — the Beta-Bernoulli formula, hour
// bucketing and vehicle-class mapping. Pure; no database.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PRIOR_ALPHA,
  PRIOR_BETA,
  acceptanceBucketKey,
  betaAcceptMean,
  hourBucketFor,
  vehicleClassFor,
} from '../src/domain/workshopAcceptance.js';

describe('betaAcceptMean — cold start falls back to the prior', () => {
  it('is exactly the prior mean with zero counts', () => {
    expect(betaAcceptMean({ accepted: 0, refused: 0 })).toBeCloseTo(
      PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA),
      10,
    );
  });

  it('moves toward 1 as accepted counts pile up', () => {
    const few = betaAcceptMean({ accepted: 2, refused: 0 });
    const many = betaAcceptMean({ accepted: 50, refused: 0 });
    expect(many).toBeGreaterThan(few);
    expect(many).toBeGreaterThan(0.9);
  });

  it('moves toward 0 as refusals pile up', () => {
    const prior = PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA);
    const many = betaAcceptMean({ accepted: 0, refused: 50 });
    expect(many).toBeLessThan(prior / 4);
  });

  it('is exactly (priorAlpha + accepted) / (priorAlpha + priorBeta + total)', () => {
    const counts = { accepted: 13, refused: 7 };
    const expected =
      (PRIOR_ALPHA + counts.accepted) / (PRIOR_ALPHA + PRIOR_BETA + counts.accepted + counts.refused);
    expect(betaAcceptMean(counts)).toBeCloseTo(expected, 10);
  });

  it('a workshop with a hundred outcomes moves less per new one than one with three', () => {
    const veteran = betaAcceptMean({ accepted: 95, refused: 5 });
    const veteranPlusOneRefusal = betaAcceptMean({ accepted: 95, refused: 6 });
    const newcomer = betaAcceptMean({ accepted: 2, refused: 1 });
    const newcomerPlusOneRefusal = betaAcceptMean({ accepted: 2, refused: 2 });

    const veteranShift = veteran - veteranPlusOneRefusal;
    const newcomerShift = newcomer - newcomerPlusOneRefusal;
    expect(veteranShift).toBeLessThan(newcomerShift);
  });
});

describe('the migration view formula matches the domain formula exactly', () => {
  // THE CROSS-CHECK THE MIGRATION'S OWN COMMENT PROMISES: PRIOR_ALPHA=8,
  // PRIOR_BETA=2 are hardcoded into the `workshop_acceptance` SQL view for a
  // human running the check block's own query, and this pins both constants
  // as NUMBERS so the two cannot silently drift apart the way a comment-only
  // cross-reference could.
  it('the SQL view hardcodes the same alpha and beta this file exports', () => {
    expect(PRIOR_ALPHA).toBe(8);
    expect(PRIOR_BETA).toBe(2);

    const migration = readFileSync(
      'prisma/migrations/20260902030000_phase22_workshop_network/migration.sql',
      'utf8',
    );
    expect(migration).toMatch(/8\.0 \+ COUNT/);
    expect(migration).toMatch(/10\.0 \+ COUNT/); // PRIOR_ALPHA + PRIOR_BETA
  });
});

describe('hourBucketFor — four buckets, in IST', () => {
  it('names each boundary correctly', () => {
    // 00:00 IST = 18:30 UTC the previous day.
    expect(hourBucketFor(new Date('2026-06-14T18:30:00Z'))).toBe('NIGHT');
    // 05:59 IST
    expect(hourBucketFor(new Date('2026-06-15T00:29:00Z'))).toBe('NIGHT');
    // 06:00 IST
    expect(hourBucketFor(new Date('2026-06-15T00:30:00Z'))).toBe('MORNING');
    // 11:59 IST
    expect(hourBucketFor(new Date('2026-06-15T06:29:00Z'))).toBe('MORNING');
    // 12:00 IST
    expect(hourBucketFor(new Date('2026-06-15T06:30:00Z'))).toBe('AFTERNOON');
    // 17:59 IST
    expect(hourBucketFor(new Date('2026-06-15T12:29:00Z'))).toBe('AFTERNOON');
    // 18:00 IST
    expect(hourBucketFor(new Date('2026-06-15T12:30:00Z'))).toBe('EVENING');
    // 23:59 IST
    expect(hourBucketFor(new Date('2026-06-15T18:29:00Z'))).toBe('EVENING');
  });
});

describe('vehicleClassFor', () => {
  it('maps null to NONE and passes LV/HV through', () => {
    expect(vehicleClassFor(null)).toBe('NONE');
    expect(vehicleClassFor('LV')).toBe('LV');
    expect(vehicleClassFor('HV')).toBe('HV');
  });
});

describe('acceptanceBucketKey', () => {
  it('is stable and distinguishes every input', () => {
    const a = acceptanceBucketKey('ws-1', 'EVENING', 'HV');
    const b = acceptanceBucketKey('ws-1', 'EVENING', 'LV');
    const c = acceptanceBucketKey('ws-2', 'EVENING', 'HV');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
