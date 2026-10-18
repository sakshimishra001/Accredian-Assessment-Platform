-- CreateEnum
CREATE TYPE "ExamCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "examCredentialId" TEXT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "assessment_candidates" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "examinerId" TEXT,
    "examinerAssignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_credentials" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" "ExamCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "issuedById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_candidates_learnerId_idx" ON "assessment_candidates"("learnerId");

-- CreateIndex
CREATE INDEX "assessment_candidates_assessmentId_examinerId_idx" ON "assessment_candidates"("assessmentId", "examinerId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_candidates_assessmentId_learnerId_key" ON "assessment_candidates"("assessmentId", "learnerId");

-- CreateIndex
CREATE INDEX "exam_credentials_candidateId_status_idx" ON "exam_credentials"("candidateId", "status");

-- CreateIndex
CREATE INDEX "sessions_examCredentialId_idx" ON "sessions"("examCredentialId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_examCredentialId_fkey" FOREIGN KEY ("examCredentialId") REFERENCES "exam_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_candidates" ADD CONSTRAINT "assessment_candidates_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_candidates" ADD CONSTRAINT "assessment_candidates_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_candidates" ADD CONSTRAINT "assessment_candidates_examinerId_fkey" FOREIGN KEY ("examinerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_credentials" ADD CONSTRAINT "exam_credentials_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "assessment_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_credentials" ADD CONSTRAINT "exam_credentials_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_credentials" ADD CONSTRAINT "exam_credentials_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

