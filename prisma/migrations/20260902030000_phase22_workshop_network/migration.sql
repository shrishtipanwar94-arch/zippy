-- PHASE 22 — workshop network.
--
-- Three changes: the columns AcceptanceOutcome needed to group by (Phase 22
-- itself named these — "with hour-of-day and vehicle class"), the JSON column
-- DispatchOption needed to carry a destination choice (mirrors part_sourcing
-- from Phase 19), and a VIEW that answers the phase's own check query without
-- the application ever reading it — the app computes P(accept) through the
-- tested `betaAcceptMean` in src/domain/workshopAcceptance.ts, from a fresh
-- count query, exactly like `accountBalance` (src/commit/ledger.ts) never
-- caches a derivable figure. This view exists for a human running the check's
-- own SQL, or a future console panel, and nothing else.

-- 1. WHAT EACH OUTCOME COUNTS TOWARD. `workshop_id` is denormalised from
-- destination_offers.workshop_id — see the Prisma model comment for why: a
-- groupBy across a relation is not how Prisma's query builder works, and this
-- read happens on every solve that touches a tow job.
ALTER TABLE "acceptance_outcomes"
  ADD COLUMN "workshop_id" TEXT NOT NULL,
  ADD COLUMN "hour_bucket" TEXT NOT NULL,
  ADD COLUMN "vehicle_class" TEXT NOT NULL;

ALTER TABLE "acceptance_outcomes"
  ADD CONSTRAINT "acceptance_outcomes_workshop_id_fkey"
  FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "acceptance_outcomes_workshop_id_hour_bucket_vehicle_class_idx"
  ON "acceptance_outcomes" ("workshop_id", "hour_bucket", "vehicle_class");

-- 2. THE CHOSEN DESTINATION, per dispatch option — Phase 19's part_sourcing
-- column, one phase later, for the same reason: an audit of a decision the
-- why-inspector reads whole rather than a field at a time.
ALTER TABLE "dispatch_options" ADD COLUMN "destination" JSONB;

-- 3. THE CHECK'S OWN VIEW. PRIOR_ALPHA=8, PRIOR_BETA=2 here MUST match
-- src/domain/workshopAcceptance.ts exactly — tests/workshopAcceptance.test.ts
-- pins both, as numbers, so the two cannot silently drift apart the way a
-- comment-only cross-reference could.
CREATE VIEW "workshop_acceptance" AS
SELECT
  w.id AS workshop_id,
  w.code AS workshop_code,
  ao.hour_bucket,
  ao.vehicle_class,
  COUNT(*) FILTER (WHERE ao.outcome = 'ACCEPTED') AS accepted_count,
  COUNT(*) FILTER (WHERE ao.outcome IN ('DECLINED', 'TIMEOUT')) AS refused_count,
  (8.0 + COUNT(*) FILTER (WHERE ao.outcome = 'ACCEPTED'))
    / (10.0 + COUNT(*)) AS p_accept
FROM "acceptance_outcomes" ao
JOIN "workshops" w ON w.id = ao.workshop_id
GROUP BY w.id, w.code, ao.hour_bucket, ao.vehicle_class;
