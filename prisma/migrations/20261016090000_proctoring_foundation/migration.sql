-- Proctoring V1, step 1: configuration, the append-only event log, and WARN as a violation action.
-- Additive only: no table or column is dropped and existing rows keep their values.

-- AlterEnum
ALTER TYPE "FocusViolationAction" ADD VALUE 'WARN';

-- CreateEnum
CREATE TYPE "ProctoringEventType" AS ENUM ('FOCUS_LOST', 'FULLSCREEN_EXIT', 'CLIPBOARD_COPY', 'CLIPBOARD_PASTE', 'FACE_NOT_DETECTED', 'MULTIPLE_FACES', 'CAMERA_DISABLED', 'CAMERA_PERMISSION_REVOKED', 'PROCTORING_STARTED', 'PROCTORING_STOPPED');

-- CreateEnum
CREATE TYPE "ProctoringSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ProctoringAction" AS ENUM ('WARNING', 'LOCK', 'TERMINATE');

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "cameraRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "clipboardMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "faceDetectionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "faceMissingDetectionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fullscreenEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "multipleFaceDetectionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "proctoring_events" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "eventType" "ProctoringEventType" NOT NULL,
    "severity" "ProctoringSeverity" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER,
    "violationNumber" INTEGER,
    "actionTaken" "ProctoringAction",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proctoring_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proctoring_events_attemptId_timestamp_idx" ON "proctoring_events"("attemptId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "proctoring_events_attemptId_violationNumber_key" ON "proctoring_events"("attemptId", "violationNumber");

-- AddForeignKey
ALTER TABLE "proctoring_events" ADD CONSTRAINT "proctoring_events_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "assessment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: focus monitoring now runs under the proctoring master switch. Assessments that already
-- monitor focus get the switch on, so they behave exactly as before; nothing else is turned on.
UPDATE "assessments" SET "proctoringEnabled" = true WHERE "focusMonitoringEnabled" = true AND "proctoringEnabled" = false;
