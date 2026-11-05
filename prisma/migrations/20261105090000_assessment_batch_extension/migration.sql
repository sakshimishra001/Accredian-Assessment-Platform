-- Batch-wide time extensions apply to attempts started after the grant too (issue: learners who started
-- after a batch extension kept the original window deadline). Additive: one column, default 0, so
-- every existing assessment behaves exactly as before.

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN "batchExtensionSeconds" INTEGER NOT NULL DEFAULT 0;
