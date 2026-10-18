-- CreateEnum
CREATE TYPE "ResponseType" AS ENUM ('TEXT', 'FILE', 'TEXT_FILE');

-- CreateEnum
CREATE TYPE "StoredFilePurpose" AS ENUM ('MATERIAL', 'ANSWER');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('ASSESSMENT', 'REMINDER', 'ASSESSMENT_UPDATE', 'RESULTS');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('ACTIVE', 'DRAFT', 'DISABLED');

-- CreateEnum
CREATE TYPE "CommunicationEvent" AS ENUM ('ASSIGNMENT', 'REMINDER', 'STARTING_SOON', 'RESCHEDULED', 'CANCELLED', 'RESULT_PUBLISHED');

-- CreateEnum
CREATE TYPE "ReminderTiming" AS ENUM ('H24', 'H12', 'H2', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'FAILED', 'NOT_DELIVERED');

-- AlterTable
ALTER TABLE "paper_questions" ADD COLUMN     "allowedFileTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fileRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxFileSizeMb" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "maxFiles" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "responseType" "ResponseType" NOT NULL DEFAULT 'TEXT';

-- CreateTable
CREATE TABLE "stored_files" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageDriver" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "purpose" "StoredFilePurpose" NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_question_materials" (
    "id" TEXT NOT NULL,
    "paperQuestionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_question_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_attachments" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CommunicationType" NOT NULL,
    "trigger" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "replyTo" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_communication_settings" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "event" "CommunicationEvent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT,
    "overrideSubject" TEXT,
    "overrideBody" TEXT,
    "reminderTiming" "ReminderTiming",
    "reminderAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_communication_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_logs" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT,
    "event" "CommunicationEvent",
    "templateId" TEXT,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storageKey_key" ON "stored_files"("storageKey");

-- CreateIndex
CREATE INDEX "stored_files_uploadedById_idx" ON "stored_files"("uploadedById");

-- CreateIndex
CREATE INDEX "paper_question_materials_paperQuestionId_position_idx" ON "paper_question_materials"("paperQuestionId", "position");

-- CreateIndex
CREATE INDEX "paper_question_materials_fileId_idx" ON "paper_question_materials"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "answer_attachments_fileId_key" ON "answer_attachments"("fileId");

-- CreateIndex
CREATE INDEX "answer_attachments_responseId_idx" ON "answer_attachments"("responseId");

-- CreateIndex
CREATE UNIQUE INDEX "communication_templates_name_key" ON "communication_templates"("name");

-- CreateIndex
CREATE INDEX "communication_templates_status_idx" ON "communication_templates"("status");

-- CreateIndex
CREATE INDEX "assessment_communication_settings_templateId_idx" ON "assessment_communication_settings"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_communication_settings_assessmentId_event_key" ON "assessment_communication_settings"("assessmentId", "event");

-- CreateIndex
CREATE INDEX "communication_logs_assessmentId_idx" ON "communication_logs"("assessmentId");

-- CreateIndex
CREATE INDEX "communication_logs_createdAt_idx" ON "communication_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_question_materials" ADD CONSTRAINT "paper_question_materials_paperQuestionId_fkey" FOREIGN KEY ("paperQuestionId") REFERENCES "paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_question_materials" ADD CONSTRAINT "paper_question_materials_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_attachments" ADD CONSTRAINT "answer_attachments_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "attempt_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_attachments" ADD CONSTRAINT "answer_attachments_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_communication_settings" ADD CONSTRAINT "assessment_communication_settings_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_communication_settings" ADD CONSTRAINT "assessment_communication_settings_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "communication_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_logs" ADD CONSTRAINT "communication_logs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "communication_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

