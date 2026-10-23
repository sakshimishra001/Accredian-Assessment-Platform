-- Proctor dashboard, phase 1: proctors (staff role REVIEWER) assigned to assessments.
-- Additive only: one new table; nothing existing is changed.
-- CreateTable
CREATE TABLE "assessment_proctors" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "proctorId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_proctors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessment_proctors_proctorId_idx" ON "assessment_proctors"("proctorId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_proctors_assessmentId_proctorId_key" ON "assessment_proctors"("assessmentId", "proctorId");

-- AddForeignKey
ALTER TABLE "assessment_proctors" ADD CONSTRAINT "assessment_proctors_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_proctors" ADD CONSTRAINT "assessment_proctors_proctorId_fkey" FOREIGN KEY ("proctorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_proctors" ADD CONSTRAINT "assessment_proctors_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

