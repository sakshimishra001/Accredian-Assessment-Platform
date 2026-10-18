-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "extensionSeconds" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "attempt_time_extensions" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "previousEndAt" TIMESTAMP(3) NOT NULL,
    "newEndAt" TIMESTAMP(3) NOT NULL,
    "bulkOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_time_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attempt_time_extensions_attemptId_idx" ON "attempt_time_extensions"("attemptId");

-- AddForeignKey
ALTER TABLE "attempt_time_extensions" ADD CONSTRAINT "attempt_time_extensions_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_time_extensions" ADD CONSTRAINT "attempt_time_extensions_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
