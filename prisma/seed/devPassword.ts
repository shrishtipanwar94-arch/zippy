// Every seeded user gets the same password, so any of them can be logged in as
// during development and tests. Phase 2 introduced argon2id hashing; this is a
// real hash of that password, computed once and reused for all seeded users
// (the salt is embedded, so one hash verifies fine for every row).
//
// THE PUBLISHED PASSWORD NEVER SHIPS. `password-dev-only` is in this file, so
// it is public the moment the repo is. A deployed seed takes its password from
// the SEED_PASSWORD secret instead, and in production it refuses to run without
// one rather than quietly falling back — a public demo whose dispatcher login
// is printed on GitHub is a public dispatcher console.

import { hashSync } from '@node-rs/argon2';

export const DEV_PASSWORD = 'password-dev-only';

// Takes the environment as an argument so the rule can be tested without
// touching process.env. Whitespace-only counts as unset: a secret pasted as a
// stray space would otherwise become every seeded user's password.
export function seedPassword(env: { NODE_ENV?: string; SEED_PASSWORD?: string }): string {
  const fromSecret = env.SEED_PASSWORD?.trim();
  if (fromSecret) return fromSecret;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'SEED_PASSWORD is not set. In production every seeded login, including the ' +
        'demo board the web process builds on boot when DEMO_MODE=true, takes its ' +
        'password from SEED_PASSWORD, and there is deliberately no fallback. Set it ' +
        'on the service (never in a committed file) and redeploy.',
    );
  }
  return DEV_PASSWORD;
}

// Named for what it is in development; in production it hashes SEED_PASSWORD.
export const DEV_PASSWORD_HASH: string = hashSync(seedPassword(process.env));
