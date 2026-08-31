-- PHASE 15c STAGE 3 — how a job gets paid for, and what happens when it cannot.
--
-- TWO ADDITIONS, both about pinning a decision rather than recomputing it.
--
-- `settlement_path` on jobs. Which of the three ways a job settles — a fleet
-- invoiced monthly, a covered consumer paying nothing, or a walk-in going
-- through a gateway — is resolved once at job creation from the driver's
-- contract and its covered services, and then never asked again. Same rule as
-- `price_list_id` at stage 1 and for the same reason: the terms a customer is
-- served under are the terms in force when they asked for help. A contract
-- that lapses mid-job does not retroactively hand them a bill.
--
-- An enum rather than a String, against this schema's usual habit of keeping
-- peripheral status columns as text, because this one is not peripheral: it is
-- the branch that decides whether a payment gateway is contacted at all, and a
-- typo'd string would take a job silently down the wrong path.
--
-- `PENDING_AUTHORISATION` on PaymentStatus. PENDING means nothing has been
-- attempted; this means we tried and could not — declined, or the provider was
-- unreachable. The difference matters because the job DISPATCHES ANYWAY
-- (payment is never on the dispatch critical path), so the two states have
-- different owners: PENDING is waiting for the flow to reach it, and
-- PENDING_AUTHORISATION is flagged for an operator and swept by a retry.

CREATE TYPE "SettlementPath" AS ENUM ('FLEET_TENANT', 'CONTRACT_CONSUMER', 'WALK_IN');

ALTER TABLE "jobs" ADD COLUMN "settlement_path" "SettlementPath";

-- Added AFTER 'PENDING' so the enum reads in the order a payment moves through
-- it. Postgres allows this inside a transaction as long as the new value is
-- not used in the same one, which it is not.
ALTER TYPE "PaymentStatus" ADD VALUE 'PENDING_AUTHORISATION' AFTER 'PENDING';
