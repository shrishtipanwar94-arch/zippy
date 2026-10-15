-- ESTIMATE CREATION IS IDEMPOTENT PER PRICED INPUTS.
--
-- A technician pressing "Send the driver a cost" twice used to issue two
-- estimates, and every one of them put an ESTIMATE_ISSUED card on the driver's
-- timeline. Now a press whose priced inputs match the current estimate is
-- answered with that estimate, and a press whose inputs changed supersedes it.
--
-- `current_for_job_id` is what makes "one current estimate per job" a database
-- fact rather than a check in code. The current estimate carries its job id;
-- a superseded one carries NULL. A plain unique index allows any number of
-- NULLs, so it permits many superseded rows and exactly one current one — and
-- two simultaneous presses that both try to insert a current row collide here,
-- however the code above them interleaves.
ALTER TABLE "estimates"
  ADD COLUMN "priced_inputs" TEXT,
  ADD COLUMN "current_for_job_id" TEXT,
  ADD COLUMN "superseded_at" TIMESTAMP(3);

-- BACKFILL: the newest estimate on each job is its current one. The older ones
-- are marked superseded as of this migration, since when they were actually
-- overtaken was never recorded. `priced_inputs` stays NULL on old rows, which
-- simply means the next press on such a job issues a fresh estimate.
UPDATE "estimates" AS e
SET "current_for_job_id" = e."job_id"
FROM (
  SELECT DISTINCT ON ("job_id") "id"
  FROM "estimates"
  ORDER BY "job_id", "created_at" DESC, "id" DESC
) AS newest
WHERE e."id" = newest."id";

UPDATE "estimates"
SET "superseded_at" = CURRENT_TIMESTAMP
WHERE "current_for_job_id" IS NULL;

CREATE UNIQUE INDEX "estimates_current_for_job_id_key" ON "estimates"("current_for_job_id");
