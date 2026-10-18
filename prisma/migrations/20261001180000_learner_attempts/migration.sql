-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED');

-- CreateTable
CREATE TABLE "assessment_attempts" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "startedSessionId" TEXT,
    "examCredentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_responses" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "assessmentQuestionId" TEXT NOT NULL,
    "selectedOptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "textAnswer" TEXT,
    "markedForReview" BOOLEAN NOT NULL DEFAULT false,
    "clientSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attempt_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_attempts_assessmentId_status_idx" ON "assessment_attempts"("assessmentId", "status");

-- CreateIndex
CREATE INDEX "assessment_attempts_learnerId_idx" ON "assessment_attempts"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_attempts_candidateId_attemptNumber_key" ON "assessment_attempts"("candidateId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_attempts_id_assessmentId_key" ON "assessment_attempts"("id", "assessmentId");

-- CreateIndex
CREATE INDEX "attempt_responses_assessmentQuestionId_idx" ON "attempt_responses"("assessmentQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_responses_attemptId_assessmentQuestionId_key" ON "attempt_responses"("attemptId", "assessmentQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_questions_id_assessmentId_key" ON "assessment_questions"("id", "assessmentId");

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "assessment_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_examCredentialId_fkey" FOREIGN KEY ("examCredentialId") REFERENCES "exam_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_responses" ADD CONSTRAINT "attempt_responses_attemptId_assessmentId_fkey" FOREIGN KEY ("attemptId", "assessmentId") REFERENCES "assessment_attempts"("id", "assessmentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_responses" ADD CONSTRAINT "attempt_responses_assessmentQuestionId_assessmentId_fkey" FOREIGN KEY ("assessmentQuestionId", "assessmentId") REFERENCES "assessment_questions"("id", "assessmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

