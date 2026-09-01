-- PHASE 18 — parts and inventory.
--
-- The inventory tables have existed since Phase 1 and nothing read them. This
-- migration is what turns them from a catalogue into a LEDGER, and that is
-- three changes:
--
--   1. unit_stock.starting_qty  — so `quantity` can be checked rather than
--      trusted. The invariant this phase is graded on is
--          starting_qty + SUM(stock_movements.delta) = quantity
--      for every row, and without a starting point there is nothing to check
--      the running total against.
--
--   2. unit_stock.confirmed_at  — STOCK IS A CLAIM, NOT A FACT. What matters
--      about a quantity is how long ago a human counted it; age is what turns
--      the number into VERIFIED / AGEING / UNVERIFIED.
--
--   3. append-only triggers on both stock tables — the same rule, and the same
--      trigger function, that job_events and ledger_entries have had since
--      Phase 1. A wrong movement is corrected with an ADJUSTED row.

-- AlterTable
--
-- `unit_id` is added NOT NULL with no default deliberately. Nothing has ever
-- written stock_confirmations — the table is empty by construction — so this
-- either succeeds or fails loudly on a database where that assumption is
-- wrong, which is the answer we want rather than a silent backfill of a
-- technician's declaration to a van they were never in.
ALTER TABLE "stock_confirmations" ADD COLUMN     "unit_id" TEXT NOT NULL,
ALTER COLUMN "job_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "technician_id" TEXT,
ADD COLUMN     "unit_stock_id" TEXT;

-- AlterTable
ALTER TABLE "unit_stock" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "starting_qty" INTEGER NOT NULL DEFAULT 0;

-- BACKFILL. Existing seeded stock has no movements behind it, so its starting
-- quantity IS its current quantity and the reconciliation holds from the first
-- run. Without this every seeded row would read as "started at zero and has
-- unexplained parts on it".
UPDATE "unit_stock" SET "starting_qty" = "quantity";

-- CreateIndex
CREATE INDEX "restock_orders_unit_id_status_idx" ON "restock_orders"("unit_id", "status");

-- CreateIndex
CREATE INDEX "stock_confirmations_unit_id_confirmed_at_idx" ON "stock_confirmations"("unit_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "stock_movements_unit_stock_id_idx" ON "stock_movements"("unit_stock_id");

-- CreateIndex
CREATE INDEX "stock_movements_job_id_idx" ON "stock_movements"("job_id");

-- AddForeignKey
--
-- ON DELETE RESTRICT, and it has to be. CASCADE would delete history to tidy
-- up mutable state, and SET NULL would issue an UPDATE against a table the
-- trigger below refuses — so removing a shelf that has movements behind it is
-- simply not allowed. History pins the row it explains.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_stock_id_fkey" FOREIGN KEY ("unit_stock_id") REFERENCES "unit_stock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_confirmations" ADD CONSTRAINT "stock_confirmations_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- APPEND-ONLY ENFORCEMENT — reusing zippy_reject_mutation() from Phase 1.
--
-- Both of these tables are evidence. The movements are the arithmetic behind
-- every unit_stock.quantity, and the confirmations are the evidence behind
-- every confidence level shown to a dispatcher. A number nobody can audit is a
-- number we made up, so the database refuses UPDATE and DELETE on them.
-- ============================================================================

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION zippy_reject_mutation();

CREATE TRIGGER stock_confirmations_append_only
  BEFORE UPDATE OR DELETE ON "stock_confirmations"
  FOR EACH ROW EXECUTE FUNCTION zippy_reject_mutation();

REVOKE UPDATE, DELETE ON "stock_movements" FROM PUBLIC;
REVOKE UPDATE, DELETE ON "stock_confirmations" FROM PUBLIC;
