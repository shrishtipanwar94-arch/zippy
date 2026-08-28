// Every seeded user gets the same password, so any of them can be logged in as
// during development and tests. This is a DEV-ONLY convenience — the value is
// deliberately obvious and must never ship. Phase 2 introduced argon2id
// hashing; this is a real hash of that password, computed once and reused for
// all seeded users (the salt is embedded, so one hash verifies fine for every
// row).

import { hashSync } from '@node-rs/argon2';

export const DEV_PASSWORD = 'password-dev-only';

export const DEV_PASSWORD_HASH: string = hashSync(DEV_PASSWORD);
