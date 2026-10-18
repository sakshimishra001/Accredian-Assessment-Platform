-- CreateEnum
CREATE TYPE "FocusViolationAction" AS ENUM ('LOCK', 'TERMINATE');

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "focusLastIncidentId" TEXT,
ADD COLUMN     "focusViolations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "focusMaxViolations" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "focusMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "focusViolationAction" "FocusViolationAction" NOT NULL DEFAULT 'TERMINATE';
