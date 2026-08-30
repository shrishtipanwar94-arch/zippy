-- CreateTable
CREATE TABLE "job_processing_log" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_processing_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_processing_log_queue_idempotency_key_key" ON "job_processing_log"("queue", "idempotency_key");
