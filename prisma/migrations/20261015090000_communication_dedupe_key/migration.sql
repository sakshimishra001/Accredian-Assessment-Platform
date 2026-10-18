-- Result Published (and any other once-only automatic email): an idempotency key per email.
-- AlterTable
ALTER TABLE "communication_logs" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "communication_logs_dedupeKey_key" ON "communication_logs"("dedupeKey");
