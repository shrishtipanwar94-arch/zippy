/**
 * Phase 0 has no domain models, so there is nothing to seed. This file exists
 * now because `npm run db:seed` is named in the build plan and every named
 * script must exist and exit cleanly from the start. Phase 1 fills it in with a
 * deliberately uneven board — scarce EV certifications, partially overlapping
 * shifts — so that later dispatch decisions are non-trivial.
 *
 * Seeding must always be idempotent: safe to run twice.
 */
async function seed(): Promise<void> {
  // Nothing to do until Phase 1 introduces the schema.
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
