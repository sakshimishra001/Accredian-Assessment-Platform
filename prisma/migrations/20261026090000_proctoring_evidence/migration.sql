-- Proctor dashboard, phase 7: proctoring evidence (camera / screen snapshots).
-- Additive only: new enum values, two settings that default to OFF for every existing assessment,
-- one new table. Image bytes are never stored in the database (private object storage only).

-- AlterEnum
ALTER TYPE "ProctoringEventType" ADD VALUE 'CAMERA_CONNECTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SCREEN_SHARE_STARTED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SCREEN_SHARE_STOPPED';
ALTER TYPE "ProctoringEventType" ADD VALUE 'SCREEN_SHARE_PERMISSION_DENIED';

-- CreateEnum
CREATE TYPE "ProctoringEvidenceType" AS ENUM ('CAMERA', 'SCREEN');

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN "cameraSnapshotsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "screenMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "proctoring_evidence" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "type" "ProctoringEvidenceType" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "relatedEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proctoring_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proctoring_evidence_storagePath_key" ON "proctoring_evidence"("storagePath");

-- CreateIndex
CREATE INDEX "proctoring_evidence_attemptId_capturedAt_idx" ON "proctoring_evidence"("attemptId", "capturedAt");

-- CreateIndex
CREATE INDEX "proctoring_evidence_assessmentId_capturedAt_idx" ON "proctoring_evidence"("assessmentId", "capturedAt");

-- CreateIndex
CREATE INDEX "proctoring_evidence_type_capturedAt_idx" ON "proctoring_evidence"("type", "capturedAt");

-- AddForeignKey
ALTER TABLE "proctoring_evidence" ADD CONSTRAINT "proctoring_evidence_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proctoring_evidence" ADD CONSTRAINT "proctoring_evidence_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
