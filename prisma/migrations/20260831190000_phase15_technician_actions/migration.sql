-- PHASE 15 — the technician's offline action queue.
--
-- A technician's phone loses signal, they tap four buttons, and all four
-- arrive together on reconnect. Every action carries an idempotency key the
-- PHONE generated at the moment of the tap; this table is what makes replaying
-- that queue safe.
--
-- The unique index on (job_id, idempotency_key) is the arbiter, exactly as
-- job_processing_log's is for a queue worker. The row is inserted in the SAME
-- transaction as the state transition it describes, so a replay hits the
-- constraint, the whole transaction rolls back, and the job cannot be
-- transitioned twice by one tap.
--
-- Two timestamps because the row originates outside the server: event_time is
-- when the technician tapped, received_at is when we heard about it. The gap
-- between them is the offline period, and it is the only durable evidence that
-- the queue did its job.
--
-- Written by hand rather than by `prisma migrate dev`, which is interactive
-- and cannot run here — the same route the Phase 14 migration took.

CREATE TABLE "technician_actions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "technician_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "client_sequence" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "event_time" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technician_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_actions_job_id_idempotency_key_key"
  ON "technician_actions"("job_id", "idempotency_key");

-- The order the taps happened in, per job. The replay assertion reads this.
CREATE INDEX "technician_actions_job_id_client_sequence_idx"
  ON "technician_actions"("job_id", "client_sequence");

ALTER TABLE "technician_actions" ADD CONSTRAINT "technician_actions_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "technician_actions" ADD CONSTRAINT "technician_actions_technician_id_fkey"
  FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
