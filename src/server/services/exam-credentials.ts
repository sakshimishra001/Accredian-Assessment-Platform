import "server-only";
import { AssessmentStatus, ExamCredentialStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { credentialWindowSchema } from "@/lib/validation/learner";
import { AuditAction, recordAudit } from "../audit";
import { generateExamCode } from "../auth/exam-code";
import { hashPassword } from "../auth/password";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";

/** Credentials can be issued while the assessment can still be taken. */
const ISSUABLE: readonly AssessmentStatus[] = [AssessmentStatus.DRAFT, AssessmentStatus.SCHEDULED, AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED];

export type CredentialState = "ACTIVE" | "NOT_YET_VALID" | "EXPIRED" | "REVOKED";

export function credentialState(c: { status: ExamCredentialStatus; validFrom: Date; validUntil: Date }, now = new Date()): CredentialState {
  if (c.status === ExamCredentialStatus.REVOKED) return "REVOKED";
  if (now < c.validFrom) return "NOT_YET_VALID";
  if (now >= c.validUntil) return "EXPIRED";
  return "ACTIVE";
}

export interface IssuedCredential {
  credentialId: string;
  candidateId: string;
  learner: { id: string; name: string; email: string };
  /** Plain exam password. Returned only here, once; only its hash is stored. */
  code: string;
  validFrom: Date;
  validUntil: Date;
}

/**
 * Validity window: defaults to the assessment's own schedule (start → end), so nothing is
 * hard-coded; an admin may override either end. This is when the learner may sign in — it is
 * deliberately separate from the attempt duration, which the attempt engine will enforce.
 */
function resolveWindow(assessment: { startAt: Date; endAt: Date }, raw: unknown, now: Date) {
  const parsed = credentialWindowSchema.safeParse(raw ?? {});
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const validFrom = parsed.data.validFrom ?? assessment.startAt;
  const validUntil = parsed.data.validUntil ?? assessment.endAt;
  if (validUntil <= validFrom) throw new ValidationError("The credential must end after it starts.", { validUntil: ["Must be after the start"] });
  if (validUntil <= now) throw new ValidationError("The credential would already have expired.", { validUntil: ["Must be in the future"] });
  return { validFrom, validUntil };
}

async function loadIssuableAssessment(tx: DbTx, assessmentId: string) {
  const a = await tx.assessment.findUnique({ where: { id: assessmentId }, select: { id: true, status: true, startAt: true, endAt: true } });
  if (!a) throw new NotFoundError("Assessment not found.");
  if (!ISSUABLE.includes(a.status)) throw new ConflictError("Exam credentials can’t be issued once the assessment has ended.");
  return a;
}

/** Revoke a candidate's active credentials and end the sessions opened with them. */
async function revokeActive(tx: DbTx, candidateIds: string[], actorId: string, now: Date) {
  const active = await tx.examCredential.findMany({
    where: { candidateId: { in: candidateIds }, status: ExamCredentialStatus.ACTIVE },
    select: { id: true },
  });
  if (active.length === 0) return 0;
  const ids = active.map((c) => c.id);
  await tx.examCredential.updateMany({ where: { id: { in: ids } }, data: { status: ExamCredentialStatus.REVOKED, revokedAt: now, revokedById: actorId } });
  await tx.session.deleteMany({ where: { examCredentialId: { in: ids } } });
  return ids.length;
}

/**
 * Issue exam passwords for candidates of one assessment (all of them when `candidateIds` is
 * omitted). Any credential a candidate already has is revoked first, so each candidate has at
 * most one active credential per assessment.
 */
export async function issueExamCredentials(
  actor: SessionUser,
  assessmentId: string,
  options: { candidateIds?: string[]; window?: unknown } = {},
  now: Date = new Date(),
): Promise<IssuedCredential[]> {
  assertAdmin(actor);
  const assessment = await loadIssuableAssessment(db, assessmentId);
  const window = resolveWindow(assessment, options.window, now);

  const candidates = await db.assessmentCandidate.findMany({
    where: { assessmentId, ...(options.candidateIds ? { id: { in: [...new Set(options.candidateIds)] } } : {}) },
    select: { id: true, learner: { select: { id: true, name: true, email: true } } },
  });
  if (options.candidateIds && candidates.length !== new Set(options.candidateIds).size) {
    throw new NotFoundError("One or more candidates are not part of this assessment.");
  }
  if (candidates.length === 0) throw new ValidationError("Assign learners to this assessment before issuing exam passwords.");

  // bcrypt is slow on purpose; hash outside the transaction.
  const issued = await Promise.all(
    candidates.map(async (c) => {
      const code = generateExamCode();
      return { candidate: c, code, codeHash: await hashPassword(code) };
    }),
  );

  return db.$transaction(async (tx) => {
    await loadIssuableAssessment(tx, assessmentId);
    await revokeActive(tx, candidates.map((c) => c.id), actor.id, now);
    const out: IssuedCredential[] = [];
    for (const { candidate, code, codeHash } of issued) {
      const cred = await tx.examCredential.create({
        data: { candidateId: candidate.id, codeHash, ...window, issuedById: actor.id },
        select: { id: true },
      });
      out.push({ credentialId: cred.id, candidateId: candidate.id, learner: candidate.learner, code, ...window });
    }
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.EXAM_CREDENTIAL_ISSUED,
        entityType: "Assessment",
        entityId: assessmentId,
        metadata: { count: out.length, validFrom: window.validFrom.toISOString(), validUntil: window.validUntil.toISOString() },
      },
      tx,
    );
    return out;
  });
}

/** Revoke one credential. Its exam sessions end immediately. */
export async function revokeExamCredential(actor: SessionUser, credentialId: string, now: Date = new Date()) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const cred = await tx.examCredential.findUnique({
      where: { id: credentialId },
      select: { id: true, status: true, candidate: { select: { assessmentId: true } } },
    });
    if (!cred) throw new NotFoundError("Credential not found.");
    if (cred.status === ExamCredentialStatus.REVOKED) throw new ConflictError("This credential is already revoked.");
    await tx.examCredential.update({ where: { id: credentialId }, data: { status: ExamCredentialStatus.REVOKED, revokedAt: now, revokedById: actor.id } });
    await tx.session.deleteMany({ where: { examCredentialId: credentialId } });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.EXAM_CREDENTIAL_REVOKED, entityType: "ExamCredential", entityId: credentialId, metadata: { assessmentId: cred.candidate.assessmentId } },
      tx,
    );
  });
}

/** Credential metadata for an assessment (never the hash or the code). */
export async function listExamCredentials(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  assertAdmin(actor);
  const rows = await db.examCredential.findMany({
    where: { candidate: { assessmentId } },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      validFrom: true,
      validUntil: true,
      createdAt: true,
      revokedAt: true,
      lastUsedAt: true,
      candidate: { select: { id: true, learner: { select: { id: true, name: true, email: true } } } },
    },
  });
  return rows.map((r) => ({ ...r, state: credentialState(r, now) }));
}
