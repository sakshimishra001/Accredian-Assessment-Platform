-- AlterEnum
ALTER TYPE "AttemptStatus" ADD VALUE 'TERMINATED';

-- AlterTable
ALTER TABLE "assessment_attempts" ADD COLUMN     "terminatedAt" TIMESTAMP(3),
ADD COLUMN     "terminatedById" TEXT,
ADD COLUMN     "terminationReason" TEXT;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_terminatedById_fkey" FOREIGN KEY ("terminatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
