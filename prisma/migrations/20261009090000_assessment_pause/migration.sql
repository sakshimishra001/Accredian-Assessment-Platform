-- AlterEnum
ALTER TYPE "AssessmentStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "pausedSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "pausedAt" TIMESTAMP(3);
