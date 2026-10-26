-- Proctor dashboard, phase 8: one-way proctor -> learner notifications during a running attempt.
-- Additive only: one new table; nothing existing is changed.
-- CreateTable
CREATE TABLE "proctor_notifications" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "proctor_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proctor_notifications_attemptId_createdAt_idx" ON "proctor_notifications"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "proctor_notifications_assessmentId_createdAt_idx" ON "proctor_notifications"("assessmentId", "createdAt");

-- CreateIndex
CREATE INDEX "proctor_notifications_senderUserId_createdAt_idx" ON "proctor_notifications"("senderUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "proctor_notifications" ADD CONSTRAINT "proctor_notifications_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proctor_notifications" ADD CONSTRAINT "proctor_notifications_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proctor_notifications" ADD CONSTRAINT "proctor_notifications_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
