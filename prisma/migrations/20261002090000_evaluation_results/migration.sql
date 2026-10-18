-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "evaluationFinalizedAt" TIMESTAMP(3),
ADD COLUMN     "evaluationFinalizedById" TEXT,
ADD COLUMN     "evaluationStatus" "EvaluationStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "attempt_responses" ADD COLUMN     "awardedMarks" DECIMAL(7,2),
ADD COLUMN     "evaluatedAt" TIMESTAMP(3),
ADD COLUMN     "evaluatedById" TEXT,
ADD COLUMN     "examinerComment" TEXT;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_evaluationFinalizedById_fkey" FOREIGN KEY ("evaluationFinalizedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_responses" ADD CONSTRAINT "attempt_responses_evaluatedById_fkey" FOREIGN KEY ("evaluatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

