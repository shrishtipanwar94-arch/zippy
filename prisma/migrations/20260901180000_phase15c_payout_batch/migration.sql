-- PHASE 15c STAGE 5 — one payout per technician per batch.
--
-- The daily run is RESUMABLE, not merely idempotent, and that distinction is
-- what this index buys. A run computes a balance and creates a payout for
-- every technician who is owed one; if the process dies halfway through, the
-- batch row already exists and half the payouts do not. Refusing to run again
-- because the batch exists would strand the rest of the technicians for a day.
--
-- So the run finds-or-creates the batch and then works through the technicians
-- it has not yet paid. This index is what makes that safe: a second attempt at
-- a technician already in the batch collides rather than creating a duplicate
-- payout, so resuming can never pay somebody twice.
--
-- The ledger posting each payout accrues is guarded separately, by its own
-- derived transaction id and the (transaction_id, account_id) unique index
-- from stage 4. Two independent guards, because a duplicate Payout row and a
-- duplicate ledger transaction are different failures.

CREATE UNIQUE INDEX "payouts_batch_id_technician_id_key"
  ON "payouts"("batch_id", "technician_id");
