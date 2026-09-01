-- PHASE 17 — the chaos switch board.
--
-- One row per thing a demo can break on purpose. Separate from
-- `system_health_states` because that table records what the system OBSERVES
-- about itself and this one records what a person has FORCED, and the first
-- question anybody asks about a red banner is which of the two it is.
--
-- In Postgres rather than in a module variable because the API and the worker
-- are two processes and a switch flipped in the console has to reach the one
-- that runs the solver. Redis is the obvious alternative and is disqualified
-- by being one of the things this table can switch off.
--
-- No enum for `name`: the set of switches is a property of the demo, not of
-- the domain, and adding one should not be a migration.

CREATE TABLE "chaos_switches" (
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chaos_switches_pkey" PRIMARY KEY ("name")
);
