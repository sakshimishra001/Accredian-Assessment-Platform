/*
  Warnings:

  - You are about to drop the column `defaultMarks` on the `questions` table. All the data in the column will be lost.
  - Made the column `snapshot` on table `assessment_questions` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `marks` to the `questions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- AlterTable
ALTER TABLE "assessment_questions" ADD COLUMN     "negativeMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
ALTER COLUMN "snapshot" SET NOT NULL;

-- AlterTable
ALTER TABLE "questions" DROP COLUMN "defaultMarks",
ADD COLUMN     "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "marks" DECIMAL(7,2) NOT NULL,
ADD COLUMN     "negativeMarks" DECIMAL(7,2) NOT NULL DEFAULT 0,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "updatedById" TEXT;

-- CreateIndex
CREATE INDEX "questions_topic_idx" ON "questions"("topic");
