-- PHASE 15c — the covered / payable split, stored.
--
-- Until now an estimate carried one number: what the work costs. That is the
-- right number for the LEDGER, which books the full value of the work however
-- it is settled — but it is the wrong number to show a customer whose contract
-- covers the job, and it was the wrong number to record an approval against.
--
-- `covered_paise` on the estimate. Stored rather than derived, because it is
-- the output of a CAP that could be edited afterwards: `covered_services` has
-- no validFrom/validTo, so recomputing the split later could produce a
-- different answer than the one the driver was shown. An estimate is a
-- financial document and every figure on it has to stay what it was.
-- Payable is `total_paise - covered_paise` and is NOT stored, because two
-- columns that must sum to a third are two chances to disagree.
--
-- `approved_amount_paise` on the approval. THE APPROVAL RECORD MUST SAY WHAT
-- WAS AGREED. A driver whose contract covers a ₹2,340 job owes ₹0, and an
-- approval on file for ₹2,340 misrepresents what they consented to — which is
-- precisely the evidence a billing dispute turns on.
--
-- NULLABLE on purpose. Approvals recorded before this migration have no
-- captured amount, and defaulting them to zero would claim those customers
-- agreed to pay nothing. Null says "not recorded", which is the truth.

ALTER TABLE "estimates" ADD COLUMN "covered_paise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "estimate_approvals" ADD COLUMN "approved_amount_paise" INTEGER;
