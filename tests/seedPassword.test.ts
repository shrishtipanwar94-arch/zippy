// SEED_PASSWORD IS REQUIRED IN PRODUCTION (prisma/seed/devPassword.ts).
//
// The published dev password is in the repository, so a deployed seed that
// fell back to it would put a public dispatcher login on a public URL. Pure
// function, no database: the rule is about the environment, nothing else.

import { describe, expect, it } from 'vitest';
import { DEV_PASSWORD, seedPassword } from '../prisma/seed/devPassword.js';

describe('seedPassword', () => {
  it('refuses to run in production without SEED_PASSWORD, and says what to set', () => {
    expect(() => seedPassword({ NODE_ENV: 'production' })).toThrow(/SEED_PASSWORD is not set/);
  });

  it('treats a blank SEED_PASSWORD in production as missing', () => {
    expect(() => seedPassword({ NODE_ENV: 'production', SEED_PASSWORD: '   ' })).toThrow(/SEED_PASSWORD/);
  });

  it('uses SEED_PASSWORD in production when it is set', () => {
    expect(seedPassword({ NODE_ENV: 'production', SEED_PASSWORD: 'from-the-secret' })).toBe('from-the-secret');
  });

  it('falls back to the published dev password only outside production', () => {
    expect(seedPassword({ NODE_ENV: 'development' })).toBe(DEV_PASSWORD);
    expect(seedPassword({ NODE_ENV: 'test' })).toBe(DEV_PASSWORD);
  });
});
