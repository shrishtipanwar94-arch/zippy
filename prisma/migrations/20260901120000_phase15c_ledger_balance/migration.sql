-- PHASE 15c STAGE 4 — the ledger's one invariant, enforced by Postgres.
--
--   For any transaction_id, SUM(ledger_entries.amount_paise) = 0.
--
-- The Phase 1 schema comment said this would be "checked in /src/commit at
-- write time". Checking it in application code is worth doing and is not
-- enough: it holds only for money written through the one function that
-- remembers to check, and a ledger's whole value is that it is true of every
-- row anybody ever wrote — including a row written by a migration, a repair
-- script, or a future phase that had not read this file.
--
-- A DEFERRED CONSTRAINT TRIGGER is what makes it a fact about the table.
-- `DEFERRABLE INITIALLY DEFERRED` means it runs at COMMIT rather than after
-- each INSERT, which is exactly what a double-entry ledger needs: the entries
-- of one transaction are written one at a time and are individually unbalanced
-- by definition. Only the state at commit has to balance.
--
-- It also means a balanced transaction MUST be written atomically. Splitting
-- one transaction_id across two database transactions fails at the first
-- commit, which is correct — half a double entry is not a smaller truth, it is
-- a wrong one.
--
-- The trigger is the second half of a pair. `ledger_entries_append_only`
-- (Phase 1) stops anything editing history; this stops anything writing
-- history that does not add up. Between them the table can only ever contain
-- balanced, immutable facts.

CREATE OR REPLACE FUNCTION ledger_transaction_balances() RETURNS trigger AS $$
DECLARE
  imbalance BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paise), 0)
    INTO imbalance
    FROM "ledger_entries"
   WHERE "transaction_id" = NEW."transaction_id";

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'ledger transaction % does not balance: entries sum to % paise',
      NEW."transaction_id", imbalance
      USING HINT = 'every transaction must sum to zero; add the missing counter-entry';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balance
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balances();

-- ONE ENTRY PER ACCOUNT PER TRANSACTION, which buys idempotency for free.
--
-- Posting the same transaction twice — a replayed technician action, a saga
-- compensating after a restart, a retried worker — would otherwise double every
-- balance in the ledger. With this index the replay collides on its first
-- entry, the whole posting transaction rolls back, and nothing is written
-- twice. The same shape `technician_actions` and `decision_records` use: the
-- database is the arbiter rather than a read-then-write in application code.
--
-- The cost is that one transaction cannot touch one account twice. Splitting a
-- technician's cash movement into "earnings settled" and "commission owed"
-- would need two entries on their account; combining them into one signed
-- amount says the same thing and keeps the guarantee.
CREATE UNIQUE INDEX "ledger_entries_transaction_id_account_id_key"
  ON "ledger_entries"("transaction_id", "account_id");
