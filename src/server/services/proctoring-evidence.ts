import "server-only";
import { ProctoringEvidenceType } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { effectiveProctoring } from "@/lib/proctoring/config";
import { EVIDENCE_MAX_BYTES, EVIDENCE_MAX_PER_ATTEMPT, EVIDENCE_MIN_GAP_MS, looksLikeJpeg, type EvidenceType } from "@/lib/proctoring/evidence";
import type { SessionUser } from "../auth/session";
import { db } from "../db";
import { emitMonitoringEvent } from "../realtime/publish";
import { evidenceStorage, evidenceStorageFor, newEvidenceKey } from "../storage";
import { assertCanProctor } from "./proctor-assignments";
import { findOwnRunningAttempt } from "./running-attempt";

/*
 * Proctoring evidence (proctor dashboard, phase 7): still JPEG snapshots of the learner's camera or
 * shared screen, taken by the exam page at randomized times (the learner is told before starting).
 *
 * Writing — the learner, for their own running attempt only, and only when that kind of evidence is
 * switched on for the assessment. The image goes to private object storage under a server-generated
 * key (proctoring/assessment/<id>/attempt/<id>/<camera|screen>/<uuid>.jpg); PostgreSQL keeps only
 * metadata (never the image, never the learner's name or email). The server's clock is the capture
 * time. At most one snapshot per type per minute and a fixed number per attempt are accepted, so
 * storage can't be flooded. Nothing here locks the attempt row: it can never hold up autosave,
 * navigation or submission, and a failure only loses that one snapshot.
 *
 * Reading — exactly who may monitor the assessment (assertCanProctor: an administrator, or an active
 * proctor assigned to it), and only evidence of an attempt of *that* assessment: a mismatched or
 * guessed id is "not found". The image itself is served only after that check, by a signed URL valid
 * for a minute (Supabase) or by the app (other drivers). Learners can't read evidence.
 *
 * Retention: evidence is kept until deleted; nothing deletes it automatically yet. Rows can't be
 * removed by deleting an attempt / assessment (Restrict), so a future retention job deletes the
 * stored object first, then the row.
 */

/** How long a signed evidence URL is valid. */
export const EVIDENCE_URL_SECONDS = 60;

function evidenceTypeOf(raw: unknown): EvidenceType {
  if (raw === ProctoringEvidenceType.CAMERA || raw === ProctoringEvidenceType.SCREEN) return raw;
  throw new ValidationError("Unknown evidence type.");
}

/** Store one snapshot for the learner's own running attempt. Returns its id and capture time — nothing about where it is stored. */
export async function uploadEvidence(actor: SessionUser, attemptId: string, rawType: unknown, data: Buffer, now: Date = new Date()) {
  const type = evidenceTypeOf(rawType);
  if (data.length === 0 || data.length > EVIDENCE_MAX_BYTES) throw new ValidationError("The snapshot is empty or too large.");
  if (!looksLikeJpeg(data)) throw new ValidationError("A snapshot must be a JPEG image.");
  const attempt = await findOwnRunningAttempt(actor, attemptId, now);
  const p = effectiveProctoring(attempt.assessment);
  if (!(type === "CAMERA" ? p.cameraSnapshots : p.screen)) throw new ConflictError("This assessment doesn’t collect this kind of evidence.");

  const [last, count] = await Promise.all([
    db.proctoringEvidence.findFirst({ where: { attemptId: attempt.id, type }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true } }),
    db.proctoringEvidence.count({ where: { attemptId: attempt.id, type } }),
  ]);
  if (last && now.getTime() - last.capturedAt.getTime() < EVIDENCE_MIN_GAP_MS) throw new ConflictError("A snapshot was stored moments ago.");
  if (count >= EVIDENCE_MAX_PER_ATTEMPT) throw new ConflictError("No more snapshots are stored for this attempt.");

  const store = evidenceStorage();
  const key = newEvidenceKey(attempt.assessmentId, attempt.id, type === "CAMERA" ? "camera" : "screen");
  await store.put(key, data, "image/jpeg");
  let evidence: { id: string; type: EvidenceType; capturedAt: Date };
  try {
    evidence = await db.proctoringEvidence.create({
      data: { assessmentId: attempt.assessmentId, attemptId: attempt.id, type, storagePath: key, storageDriver: store.name, mimeType: "image/jpeg", fileSize: data.length, capturedAt: now },
      select: { id: true, type: true, capturedAt: true },
    });
  } catch (err) {
    // No row, no object: never leave an image nobody can find.
    await store.delete(key).catch(() => {});
    throw err;
  }
  // Stored: tell the assessment's dashboards (identifiers only — never the image or a URL).
  emitMonitoringEvent("PROCTORING_EVIDENCE_AVAILABLE", attempt.assessmentId, attempt.id, now, { evidenceId: evidence.id, evidenceType: evidence.type });
  return evidence;
}

/** An id from a URL: a non-empty string, or "not found" (an empty or missing id must never widen a lookup). */
function idOf(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw) throw new NotFoundError(`${what} not found.`);
  return raw;
}

/** The attempt must belong to the assessment the actor may proctor. */
async function assertAttemptOfAssessment(actor: SessionUser, assessmentId: string, attemptId: string) {
  await assertCanProctor(actor, assessmentId);
  idOf(attemptId, "Attempt");
  const attempt = await db.assessmentAttempt.findFirst({ where: { id: attemptId, assessmentId }, select: { id: true } });
  if (!attempt) throw new NotFoundError("Attempt not found.");
}

const listSelect = { id: true, type: true, capturedAt: true, fileSize: true } as const;

/** An attempt's evidence, oldest first (metadata only). */
export async function listAttemptEvidence(actor: SessionUser, assessmentId: string, attemptId: string) {
  await assertAttemptOfAssessment(actor, assessmentId, attemptId);
  return db.proctoringEvidence.findMany({ where: { attemptId, assessmentId }, orderBy: [{ capturedAt: "asc" }, { id: "asc" }], select: listSelect });
}

export type EvidenceItem = Awaited<ReturnType<typeof listAttemptEvidence>>[number];

/** Evidence counts per attempt of one assessment (callers authorize first). */
export async function evidenceCountsByAttempt(assessmentId: string, attemptIds: string[]) {
  if (attemptIds.length === 0) return new Map<string, number>();
  const groups = await db.proctoringEvidence.groupBy({ by: ["attemptId"], where: { assessmentId, attemptId: { in: attemptIds } }, _count: { _all: true } });
  return new Map(groups.map((g) => [g.attemptId, g._count._all]));
}

/** One snapshot of an attempt of an assessment the actor may proctor, with its neighbours (for the viewer). */
export async function getEvidence(actor: SessionUser, assessmentId: string, attemptId: string, evidenceId: string) {
  await assertAttemptOfAssessment(actor, assessmentId, attemptId);
  idOf(evidenceId, "Evidence");
  const all = await db.proctoringEvidence.findMany({ where: { attemptId, assessmentId }, orderBy: [{ capturedAt: "asc" }, { id: "asc" }], select: listSelect });
  const index = all.findIndex((e) => e.id === evidenceId);
  if (index < 0) throw new NotFoundError("Evidence not found.");
  return { evidence: all[index], position: index + 1, total: all.length, previousId: all[index - 1]?.id ?? null, nextId: all[index + 1]?.id ?? null };
}

/**
 * The image of one snapshot, for an authorized viewer only: a signed URL valid for a minute when the
 * storage can make one, otherwise the bytes (served by the app). Ids that don't line up — another
 * attempt's or assessment's evidence, a guessed id — are "not found".
 */
export async function evidenceImage(actor: SessionUser, assessmentId: string, attemptId: string, evidenceId: string): Promise<{ url: string } | { data: Buffer }> {
  await assertAttemptOfAssessment(actor, assessmentId, attemptId);
  idOf(evidenceId, "Evidence");
  const row = await db.proctoringEvidence.findFirst({ where: { id: evidenceId, attemptId, assessmentId }, select: { storagePath: true, storageDriver: true } });
  if (!row) throw new NotFoundError("Evidence not found.");
  const store = evidenceStorageFor(row.storageDriver);
  if (store.signedUrl) return { url: await store.signedUrl(row.storagePath, EVIDENCE_URL_SECONDS) };
  return { data: await store.get(row.storagePath) };
}
