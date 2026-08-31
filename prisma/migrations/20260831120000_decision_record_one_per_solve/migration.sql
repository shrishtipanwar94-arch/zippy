-- ONE DECISION PER JOB PER SOLVE.
--
-- Two dispatchers looking at the same board can both press Select. Without a
-- constraint the job ends up with two decision records and two
-- PLAN_OVERRIDDEN events describing incompatible choices, and the inspector
-- silently shows whichever landed last. The database is the arbiter here, the
-- same shape Phases 5, 11 and 12 use — a read-then-write has a window between
-- the check and the insert that two concurrent callers both pass through.
--
-- Scoped to the RUN rather than the job: a later solve is a genuinely new
-- decision (a re-dispatch, a changed diagnosis) and must stay recordable.
-- What this forbids is deciding the same solve twice.

-- Existing duplicates are development data written before the constraint
-- existed, from a smoke test that selected two different plans for one run.
-- The EARLIEST row per (job, run) is kept: it is the decision that was
-- actually first, and a later contradicting one is exactly what this
-- constraint exists to prevent from being written at all.
DELETE FROM "decision_records" a
USING "decision_records" b
WHERE a."job_id" = b."job_id"
  AND a."solver_run_id" IS NOT DISTINCT FROM b."solver_run_id"
  AND (a."created_at" > b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" > b."id"));

CREATE UNIQUE INDEX "decision_records_job_id_solver_run_id_key"
  ON "decision_records"("job_id", "solver_run_id");
