-- CreateEnum
CREATE TYPE "AssessmentTimingMode" AS ENUM ('WINDOW', 'FULL_DURATION');

-- CreateEnum
CREATE TYPE "ResultDetail" AS ENUM ('SCORE', 'SCORE_AND_ANSWERS', 'FULL_FEEDBACK');

-- AlterTable
ALTER TABLE "assessment_questions" ADD COLUMN     "paperQuestionId" TEXT;

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "allowMarkForReview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowResume" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "negativeMarking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "paperId" TEXT,
ADD COLUMN     "randomizeOptions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "randomizeQuestions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resultDetail" "ResultDetail" NOT NULL DEFAULT 'SCORE',
ADD COLUMN     "showQuestionPalette" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timingMode" "AssessmentTimingMode" NOT NULL DEFAULT 'WINDOW';

-- CreateIndex
CREATE INDEX "assessments_paperId_idx" ON "assessments"("paperId");

-- CreateIndex
CREATE INDEX "assessments_batchId_idx" ON "assessments"("batchId");

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "question_papers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_paperQuestionId_fkey" FOREIGN KEY ("paperQuestionId") REFERENCES "paper_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

