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

function seedPassword(): string {
  const fromSecret = process.env.SEED_PASSWORD;
  if (fromSecret) return fromSecret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEED_PASSWORD must be set to seed a production database');
  }
  return DEV_PASSWORD;
}

// Named for what it is in development; in production it hashes SEED_PASSWORD.
export const DEV_PASSWORD_HASH: string = hashSync(seedPassword());
