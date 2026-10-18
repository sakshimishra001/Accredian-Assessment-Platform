import "server-only";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { AttemptStatus, FileScanStatus, ResponseType, Role, StoredFilePurpose } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { MATERIAL_EXTENSIONS, MAX_MATERIAL_MB } from "@/lib/files/types";
import { canEditPaper, PAPER_IN_USE_MESSAGE } from "@/lib/papers/rules";
import { hasOptions } from "@/lib/questions/types";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { materialDescriptionSchema } from "@/lib/validation/files";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { malwareScanner } from "../files/scan";
import { validateUpload, type ValidatedFile } from "../files/validate";
import { recentlyRecorded } from "../security/recent";
import { newStorageKey, storage, storageFor } from "../storage";
import { withOpenAttempt } from "./attempts";

/*
 * Files: supporting materials (admin, on questions of draft papers) and learner answer uploads
 * (on the learner's own open attempt). Bytes go to the storage provider under a server-generated
 * key; PostgreSQL keeps the metadata. Every read is authorised against the file's context.
 */

export interface Upload {
  name: string;
  data: Buffer;
}

const MB = 1024 * 1024;

type StoredMeta = { storageKey: string; storageDriver: string; scanStatus: FileScanStatus; scannedBy: string | null };

/**
 * Scan the bytes (an infected file is refused and nothing is stored), put them in storage, then run
 * `write` (which records the StoredFile). Undo the put if `write` fails.
 */
async function withStoredObject<T>(actor: SessionUser, purpose: "material" | "answer", v: ValidatedFile, write: (meta: StoredMeta) => Promise<T>): Promise<T> {
  const result = await malwareScanner().scan(v.data);
  if (result.status === "INFECTED") {
    await recordAudit({
      actorId: actor.id,
      action: AuditAction.FILE_REJECTED,
      entityType: "User",
      entityId: actor.id,
      metadata: { purpose, fileName: v.fileName, sha256: v.sha256, scanner: result.scanner, signature: result.signature },
    });
    throw new ValidationError("This file was flagged by the malware scanner and wasn’t uploaded.", { file: ["Flagged by the malware scanner"] });
  }
  const scan = result.status === "CLEAN" ? { scanStatus: FileScanStatus.CLEAN, scannedBy: result.scanner } : { scanStatus: FileScanStatus.NOT_SCANNED, scannedBy: null };
  const provider = storage();
  const storageKey = newStorageKey(purpose, v.extension);
  await provider.put(storageKey, v.data);
  try {
    return await write({ storageKey, storageDriver: provider.name, ...scan });
  } catch (err) {
    await provider.delete(storageKey).catch(() => {});
    throw err;
  }
}

function fileRow(v: ValidatedFile, meta: StoredMeta, purpose: StoredFilePurpose, uploadedById: string) {
  return { ...meta, fileName: v.fileName, extension: v.extension, mimeType: v.mimeType, sizeBytes: v.sizeBytes, sha256: v.sha256, purpose, uploadedById };
}

/**
 * Remove stored files nothing refers to any more — after a material or answer file was removed or
 * replaced, or a question or section holding materials was deleted. A file still used elsewhere
 * (e.g. by another version of the paper, which shares its materials) is kept. The metadata row is
 * deleted only while unreferenced (one atomic statement), and only then are the bytes removed.
 */
export async function deleteUnreferencedFiles(fileIds: string[], actorId: string | null = null) {
  let deleted = 0;
  for (const id of new Set(fileIds)) {
    const file = await db.storedFile.findUnique({ where: { id }, select: { storageKey: true, storageDriver: true, purpose: true } });
    if (!file) continue;
    const { count } = await db.storedFile.deleteMany({ where: { id, materials: { none: {} }, answerAttachments: { none: {} } } });
    if (count === 0) continue;
    deleted++;
    await storageFor(file.storageDriver)
      .delete(file.storageKey)
      .catch((err) => console.error(`Stored object ${file.storageKey} could not be deleted:`, err));
    await recordAudit({ actorId, action: AuditAction.FILE_DELETED, entityType: "StoredFile", entityId: id, metadata: { purpose: file.purpose } });
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Supporting materials (admin)
// ---------------------------------------------------------------------------

async function loadDraftPaperItem(tx: DbTx, paperQuestionId: string) {
  const item = await tx.paperQuestion.findUnique({ where: { id: paperQuestionId }, select: { id: true, paperId: true, paper: { select: { _count: { select: { assessments: true } } } } } });
  if (!item) throw new NotFoundError("Question not found.");
  if (!canEditPaper(item.paper._count.assessments)) throw new ConflictError(PAPER_IN_USE_MESSAGE);
  return item;
}

/** Attach a supporting material (image, PDF, Word, Excel/CSV, PowerPoint) to a question or case of a draft paper. */
export async function addMaterial(actor: SessionUser, paperQuestionId: string, upload: Upload, rawDescription?: unknown) {
  assertAdmin(actor);
  const description = materialDescriptionSchema.safeParse(rawDescription ?? null);
  if (!description.success) throw ValidationError.fromZod(description.error);
  await loadDraftPaperItem(db, paperQuestionId);
  const v = validateUpload(upload, { allowed: MATERIAL_EXTENSIONS, maxBytes: MAX_MATERIAL_MB * MB });

  return withStoredObject(actor, "material", v, (meta) =>
    db.$transaction(async (tx) => {
      const item = await loadDraftPaperItem(tx, paperQuestionId);
      const file = await tx.storedFile.create({ data: fileRow(v, meta, StoredFilePurpose.MATERIAL, actor.id), select: { id: true } });
      const last = await tx.paperQuestionMaterial.aggregate({ where: { paperQuestionId }, _max: { position: true } });
      const material = await tx.paperQuestionMaterial.create({
        data: { paperQuestionId, fileId: file.id, description: description.data, position: (last._max.position ?? 0) + 1 },
        select: { id: true, description: true, file: { select: { id: true, fileName: true, extension: true, sizeBytes: true, mimeType: true } } },
      });
      await tx.questionPaper.update({ where: { id: item.paperId }, data: { updatedById: actor.id } });
      await recordAudit(
        { actorId: actor.id, action: AuditAction.MATERIAL_ADDED, entityType: "QuestionPaper", entityId: item.paperId, metadata: { paperQuestionId, fileId: file.id, fileName: v.fileName, sizeBytes: v.sizeBytes } },
        tx,
      );
      return material;
    }),
  );
}

/** Remove a material from a question of a draft paper. The stored file goes too unless another version still uses it. */
export async function removeMaterial(actor: SessionUser, materialId: string) {
  assertAdmin(actor);
  const removed = await db.$transaction(async (tx) => {
    const m = await tx.paperQuestionMaterial.findUnique({ where: { id: materialId }, select: { id: true, fileId: true, paperQuestionId: true } });
    if (!m) throw new NotFoundError("Material not found.");
    const item = await loadDraftPaperItem(tx, m.paperQuestionId);
    await tx.paperQuestionMaterial.delete({ where: { id: materialId } });
    await recordAudit({ actorId: actor.id, action: AuditAction.MATERIAL_REMOVED, entityType: "QuestionPaper", entityId: item.paperId, metadata: { materialId, fileId: m.fileId } }, tx);
    return m;
  });
  await deleteUnreferencedFiles([removed.fileId], actor.id);
}

// ---------------------------------------------------------------------------
// Learner answer files
// ---------------------------------------------------------------------------

/** The question's file settings for this assessment; only written questions configured for files accept uploads. */
async function fileRules(tx: DbTx, assessmentId: string, assessmentQuestionId: string) {
  const q = await tx.assessmentQuestion.findFirst({
    where: { id: assessmentQuestionId, assessmentId },
    select: { snapshot: true, paperQuestion: { select: { responseType: true, allowedFileTypes: true, maxFileSizeMb: true, maxFiles: true } } },
  });
  if (!q) throw new NotFoundError("Question not found.");
  const pq = q.paperQuestion;
  if (hasOptions((q.snapshot as unknown as QuestionSnapshot).type) || !pq || pq.responseType === ResponseType.TEXT) {
    throw new ValidationError("This question doesn’t accept file uploads.");
  }
  return pq;
}

/**
 * Upload a file to the learner's own answer. Same rules as autosave: only an open attempt of the
 * learner's exam session, before its deadline. `replaceAttachmentId` swaps an earlier file.
 */
export async function uploadAnswerFile(
  actor: SessionUser,
  attemptId: string,
  assessmentQuestionId: string,
  upload: Upload,
  options: { replaceAttachmentId?: string } = {},
  now: Date = new Date(),
) {
  // Validate against the question's rules before storing anything (a cheap first pass; rechecked under the lock).
  const peek = await db.assessmentAttempt.findFirst({ where: ownAttemptWhere(actor.id, attemptId), select: { assessmentId: true } });
  if (!peek) throw new NotFoundError("Attempt not found.");
  const rules = await fileRules(db, peek.assessmentId, assessmentQuestionId);
  const v = validateUpload(upload, { allowed: rules.allowedFileTypes, maxBytes: rules.maxFileSizeMb * MB });

  let replacedFileId: string | null = null;
  const result = await withStoredObject(actor, "answer", v, (meta) =>
    withOpenAttempt(actor, attemptId, now, async (tx, attempt) => {
      const r = await fileRules(tx, attempt.assessmentId, assessmentQuestionId);
      const response = await tx.attemptResponse.upsert({
        where: { attemptId_assessmentQuestionId: { attemptId, assessmentQuestionId } },
        create: { attemptId, assessmentId: attempt.assessmentId, assessmentQuestionId },
        update: {},
        select: { id: true, attachments: { select: { id: true, fileId: true } } },
      });
      if (options.replaceAttachmentId) {
        const old = response.attachments.find((a) => a.id === options.replaceAttachmentId);
        if (!old) throw new NotFoundError("File to replace not found.");
        await tx.answerAttachment.delete({ where: { id: old.id } });
        replacedFileId = old.fileId;
      } else if (response.attachments.length >= r.maxFiles) {
        throw new ValidationError(r.maxFiles === 1 ? "This question takes one file. Replace or remove the current file first." : `This question takes at most ${r.maxFiles} files.`, {
          file: ["Too many files"],
        });
      }
      const file = await tx.storedFile.create({ data: fileRow(v, meta, StoredFilePurpose.ANSWER, actor.id), select: { id: true, fileName: true, extension: true, sizeBytes: true } });
      const attachment = await tx.answerAttachment.create({ data: { responseId: response.id, fileId: file.id }, select: { id: true } });
      await recordAudit(
        { actorId: actor.id, action: AuditAction.ANSWER_FILE_UPLOADED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { assessmentQuestionId, fileId: file.id, replaced: options.replaceAttachmentId ?? null } },
        tx,
      );
      return { attachmentId: attachment.id, file };
    }),
  );
  if (replacedFileId) await deleteUnreferencedFiles([replacedFileId], actor.id);
  return result;
}

/** Remove a file from the learner's own open attempt. */
export async function removeAnswerFile(actor: SessionUser, attemptId: string, attachmentId: string, now: Date = new Date()) {
  const fileId = await withOpenAttempt(actor, attemptId, now, async (tx) => {
    const a = await tx.answerAttachment.findFirst({ where: { id: attachmentId, response: { attemptId } }, select: { id: true, fileId: true } });
    if (!a) throw new NotFoundError("File not found.");
    await tx.answerAttachment.delete({ where: { id: a.id } });
    await recordAudit({ actorId: actor.id, action: AuditAction.ANSWER_FILE_REMOVED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { fileId: a.fileId } }, tx);
    return a.fileId;
  });
  await deleteUnreferencedFiles([fileId], actor.id);
}

// ---------------------------------------------------------------------------
// Reading a file (download / preview), authorised by its context
// ---------------------------------------------------------------------------

const SUBMITTED = [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED];

/**
 * May this user read the file? Admins: any. Proctors (reviewers): none — papers have no review step,
 * so they read no paper materials and never learners' answers. Examiners: materials
 * of assessments they evaluate and answer files of their assigned candidates' submitted attempts.
 * Learners: materials of their exam's assessment and their own answer files in it.
 */
async function canRead(actor: SessionUser, fileId: string): Promise<boolean> {
  switch (actor.role) {
    case Role.ADMIN:
      return true;
    case Role.EXAMINER: {
      const material = await db.paperQuestionMaterial.count({
        where: {
          fileId,
          paperQuestion: {
            OR: [
              { assessmentQuestions: { some: { assessment: { candidates: { some: { examinerId: actor.id } } } } } },
              { children: { some: { assessmentQuestions: { some: { assessment: { candidates: { some: { examinerId: actor.id } } } } } } } },
            ],
          },
        },
      });
      if (material) return true;
      return (await db.answerAttachment.count({ where: { fileId, response: { attempt: { status: { in: SUBMITTED }, candidate: { examinerId: actor.id } } } } })) > 0;
    }
    case Role.LEARNER: {
      // Material of an assessment the learner has taken (or is taking) — never before they start.
      const inMyAssessment = { assessmentQuestions: { some: { assessment: { attempts: { some: { learnerId: actor.id } } } } } };
      const material = await db.paperQuestionMaterial.count({
        where: { fileId, paperQuestion: { OR: [inMyAssessment, { children: { some: inMyAssessment } }] } },
      });
      if (material) return true;
      return (await db.answerAttachment.count({ where: { fileId, response: { attempt: { learnerId: actor.id } } } })) > 0;
    }
    default:
      return false;
  }
}

/**
 * The file's metadata and bytes, if the user may read it. Anything else is "not found". Reads are
 * audited (who, which file — never the content), at most once per user and file every 10 minutes
 * per server process so previews and reloads don't flood the log.
 */
export async function readFile(actor: SessionUser, fileId: string, meta: { ipAddress?: string | null } = {}) {
  const file = await db.storedFile.findUnique({
    where: { id: fileId },
    select: { id: true, fileName: true, extension: true, mimeType: true, sizeBytes: true, storageKey: true, storageDriver: true, purpose: true },
  });
  if (!file || !(await canRead(actor, fileId))) throw new NotFoundError("File not found.");
  let data: Buffer;
  try {
    data = await storageFor(file.storageDriver).get(file.storageKey);
  } catch {
    throw new NotFoundError("File not found.");
  }
  if (!recentlyRecorded(`file:${actor.id}:${fileId}`)) {
    await recordAudit({ actorId: actor.id, action: AuditAction.FILE_ACCESSED, entityType: "StoredFile", entityId: fileId, metadata: { purpose: file.purpose }, ipAddress: meta.ipAddress });
  }
  return { file, data };
}

/** Uploading needs a signed-in admin (materials) or learner (answers, to their own open attempt). */
export function assertCanUpload(actor: SessionUser, purpose: "material" | "answer") {
  if (purpose === "material" ? actor.role !== Role.ADMIN : actor.role !== Role.LEARNER) throw new ForbiddenError();
}
