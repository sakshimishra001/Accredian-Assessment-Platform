-- CreateEnum
CREATE TYPE "QuestionPaperStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "SectionAttemptRule" AS ENUM ('ALL', 'ANY_N', 'EXACTLY_N', 'UP_TO_N', 'BEST_N');

-- CreateEnum
CREATE TYPE "QuestionGroupType" AS ENUM ('CASE_STUDY', 'COMPREHENSION');

-- CreateTable
CREATE TABLE "question_papers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "courseId" TEXT NOT NULL,
    "subject" TEXT,
    "durationMinutes" INTEGER,
    "status" "QuestionPaperStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "basedOnId" TEXT,
    "sourceFileName" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_sections" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "position" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "attemptRule" "SectionAttemptRule" NOT NULL DEFAULT 'ALL',
    "attemptCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_questions" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL,
    "questionId" TEXT,
    "groupType" "QuestionGroupType",
    "marks" DECIMAL(7,2),
    "negativeMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "questionVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "question_papers_status_idx" ON "question_papers"("status");

-- CreateIndex
CREATE INDEX "question_papers_courseId_idx" ON "question_papers"("courseId");

-- CreateIndex
CREATE INDEX "question_papers_basedOnId_idx" ON "question_papers"("basedOnId");

-- CreateIndex
CREATE INDEX "paper_sections_paperId_position_idx" ON "paper_sections"("paperId", "position");

-- CreateIndex
CREATE INDEX "paper_questions_sectionId_parentId_position_idx" ON "paper_questions"("sectionId", "parentId", "position");

-- CreateIndex
CREATE INDEX "paper_questions_questionId_idx" ON "paper_questions"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_questions_paperId_questionId_key" ON "paper_questions"("paperId", "questionId");

-- AddForeignKey
ALTER TABLE "question_papers" ADD CONSTRAINT "question_papers_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_papers" ADD CONSTRAINT "question_papers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_papers" ADD CONSTRAINT "question_papers_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_papers" ADD CONSTRAINT "question_papers_basedOnId_fkey" FOREIGN KEY ("basedOnId") REFERENCES "question_papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_sections" ADD CONSTRAINT "paper_sections_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "question_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "question_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "paper_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

