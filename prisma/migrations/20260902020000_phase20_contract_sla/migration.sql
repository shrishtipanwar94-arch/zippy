-- PHASE 20 — contract SLA enters the objective.
--
-- Two changes, both about making "the terms in force" a single, priceable
-- answer.

-- 1. WHAT A BREACH COSTS. Until now an SLA policy said how fast we promised to
-- arrive but not what happens if we do not, so the promise could not be priced
-- against anything else the solver cares about. Defaults to 0 so every existing
-- row keeps behaving exactly as it did: no penalty, no exposure, no change to
-- any decision already made.
ALTER TABLE "sla_policies"
  ADD COLUMN "breach_penalty_paise" INTEGER NOT NULL DEFAULT 0;

-- 2. ONE POLICY PER (CONTRACT, SERVICE TYPE). A job pins its SLA policy at
-- creation and never re-reads it, which needs "which policy applies to a
-- HIGHWAY callout under this contract" to have exactly one answer rather than
-- whichever row a query happened to return first.
CREATE UNIQUE INDEX "sla_policies_contract_id_service_type_key"
  ON "sla_policies" ("contract_id", "service_type");
