-- Phase 19: the part-sourcing decision candidate generation made, kept next
-- to the cost breakdown it was priced into.
ALTER TABLE "dispatch_options" ADD COLUMN "part_sourcing" JSONB;
