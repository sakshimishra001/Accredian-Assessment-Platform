-- Proctoring V1, step 3: cut is its own clipboard event (never recorded as a copy).
-- AlterEnum
ALTER TYPE "ProctoringEventType" ADD VALUE 'CLIPBOARD_CUT' AFTER 'CLIPBOARD_COPY';
