-- PHASE 17 — a solver run says whether it ran out of time.
--
-- A plan produced under a deadline is a different artifact from a plan
-- produced to completion: it is the best one FOUND, not the best one there is,
-- and the jobs the planner never reached are not "unassignable" — they are
-- unexamined. Without this column those two look identical in the audit trail,
-- and "why was this job not planned" has no answer.
--
-- Defaults false: every run before this migration ran to completion, which is
-- true rather than merely convenient.

ALTER TABLE "solver_runs" ADD COLUMN "timed_out" BOOLEAN NOT NULL DEFAULT false;
