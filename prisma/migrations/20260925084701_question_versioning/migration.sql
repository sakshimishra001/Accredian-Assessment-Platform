-- AlterTable
ALTER TABLE "assessment_questions" ADD COLUMN     "questionVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
