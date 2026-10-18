import "server-only";
import { AssessmentStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { AuditAction, recordAudit } from "../audit";
import { db } from "../db";
import { syncTimeBasedStatuses } from "../services/assessments";
import { verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, resultsAccessUntil, type RequestMeta, type SessionUser } from "./session";

/** Lifecycle states in which a candidate may sign in to the assessment. */
const OPEN_FOR_SIGN_IN: readonly AssessmentStatus[] = [AssessmentStatus.SCHEDULED, AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED];

export type ExamLoginFailure = "invalid_credentials" | "account_disabled" | "not_yet_valid" | "expired" | "assessment_unavailable";

export type ExamLoginResult =
  | { ok: true; user: SessionUser & { assessmentId: string }; token: string; expiresAt: Date }
  | { ok: false; reason: ExamLoginFailure; validFrom?: Date };

/**
 * Every exam sign-in costs at least this many bcrypt checks — an unknown email, a non-learner and
 * a typical learner (up to this many usable passwords) all cost exactly this, so timing doesn't
 * reveal accounts.
 */
export const EXAM_LOGIN_CHECKS = 2;
/**
 * Hard cap on bcrypt checks per exam sign-in. Only a learner holding more than EXAM_LOGIN_CHECKS
 * usable passwords at once (several open/upcoming/results-only assessments) costs more. (A
 * single-check keyed lookup would need an indexed column — a later schema change.)
 */
export const EXAM_LOGIN_MAX_CHECKS = 5;

/**
 * Compare the code with the learner's active credentials, most relevant first: valid right now,
 * then upcoming (so "not active yet" is still reported), then results-only (published), newest
 * first within each — all of these are checked, up to EXAM_LOGIN_MAX_CHECKS. Expired credentials
 * (which can only produce "expired") and then dummy checks pad the work to EXAM_LOGIN_CHECKS.
 * All checks run; there is no early exit.
 */
async function matchCredential<C extends { codeHash: string; validFrom: Date; validUntil: Date; createdAt: Date; publishedAt: Date | null }>(code: string, credentials: C[], now: Date) {
  const resultsOnly = (c: C) => !!c.publishedAt && now < resultsAccessUntil(c.publishedAt);
  const rank = (c: C) => (now < c.validFrom ? 1 : now < c.validUntil ? 0 : resultsOnly(c) ? 2 : 3);
  const sorted = [...credentials].sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime());
  const usable = sorted.filter((c) => rank(c) < 3).length;
  const candidates = sorted.slice(0, Math.min(Math.max(usable, EXAM_LOGIN_CHECKS), EXAM_LOGIN_MAX_CHECKS));
  const results: boolean[] = [];
  for (let i = 0; i < Math.max(candidates.length, EXAM_LOGIN_CHECKS); i++) {
    results.push(candidates[i] ? await verifyPassword(code, candidates[i].codeHash) : await verifyAgainstDummy(code));
  }
  return candidates.find((_, i) => results[i]);
}

/** The same cost as a typical exam sign-in, for refused (throttled) attempts. */
export async function burnExamLoginWork(code: string) {
  for (let i = 0; i < EXAM_LOGIN_CHECKS; i++) await verifyAgainstDummy(code);
}

export type LearnerLoginResult =
  | { ok: true; user: SessionUser; token: string; expiresAt: Date; method: "password" | "exam_credential" }
  | { ok: false; reason: ExamLoginFailure; validFrom?: Date };

/** Exam passwords were issued as upper-case codes; "x7k-92p " and "X7K92P" are the same code. */
export const normalizeExamCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

/**
 * Learner sign-in: email + the learner's own password (User.passwordHash, bcrypt). The password
 * authenticates the learner only — which assessments they can open is decided by their assignments,
 * on every request, by the learner services. No assessment is checked here: a learner with nothing
 * open still signs in (to their dashboard).
 *
 * Migration path: a learner who has no password yet can still sign in with an assessment-specific
 * exam password issued before learner passwords existed (authenticateExamCredential, unchanged
 * rules). Once a learner has a password, their old exam passwords no longer sign in.
 *
 * Every attempt costs the same bcrypt work (EXAM_LOGIN_CHECKS), and unknown email, non-learner
 * accounts and wrong passwords all return `invalid_credentials`.
 */
export async function authenticateLearner(email: string, password: string, meta: RequestMeta = {}, now: Date = new Date()): Promise<LearnerLoginResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const learner = await db.user.findUnique({ where: { email: normalizedEmail }, select: { id: true, email: true, name: true, role: true, status: true, passwordHash: true } });
  if (learner?.role !== Role.LEARNER || !learner.passwordHash) {
    const legacy = await authenticateExamCredential(normalizedEmail, normalizeExamCode(password), meta, now);
    return legacy.ok ? { ok: true, user: legacy.user, token: legacy.token, expiresAt: legacy.expiresAt, method: "exam_credential" } : legacy;
  }

  const matches = await verifyPassword(password, learner.passwordHash);
  for (let i = 1; i < EXAM_LOGIN_CHECKS; i++) await verifyAgainstDummy(password);
  const fail = async (reason: ExamLoginFailure): Promise<LearnerLoginResult> => {
    await recordAudit({
      actorId: learner.id,
      action: AuditAction.EXAM_LOGIN_FAILED,
      entityType: "User",
      entityId: learner.id,
      metadata: { email: normalizedEmail, reason, method: "password" },
      ipAddress: meta.ipAddress,
    });
    return { ok: false, reason };
  };
  if (!matches) return fail("invalid_credentials");
  if (learner.status !== UserStatus.ACTIVE) return fail("account_disabled");

  const { token, expiresAt } = await createSession(learner.id, meta, { kind: "learner" }, now);
  await db.user.update({ where: { id: learner.id }, data: { lastLoginAt: now } });
  await recordAudit({ actorId: learner.id, action: AuditAction.EXAM_LOGIN_SUCCEEDED, entityType: "User", entityId: learner.id, metadata: { method: "password" }, ipAddress: meta.ipAddress });
  return { ok: true, user: { id: learner.id, email: learner.email, name: learner.name, role: learner.role }, token, expiresAt, method: "password" };
}

/**
 * Legacy learner sign-in: email + assessment-specific exam password (see authenticateLearner).
 *
 * The code is compared (bcrypt) against the learner's ACTIVE credentials; a match identifies the
 * candidate row, and therefore the one assessment this session is for. A credential only exists
 * for an assigned candidate, so "assigned to the assessment" is guaranteed by the data model.
 *
 * After results are published the credential keeps working for a bounded results-only period — see below.
 *
 * Unknown email, non-learner accounts, wrong or revoked codes all return `invalid_credentials`
 * with similar timing. The more specific reasons (disabled, not yet valid, expired, assessment
 * closed) are only returned after a correct code has been supplied.
 */
export async function authenticateExamCredential(
  email: string,
  code: string,
  meta: RequestMeta = {},
  now: Date = new Date(),
): Promise<ExamLoginResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const learner = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      passwordHash: true,
      candidacies: {
        select: {
          assessmentId: true,
          assessment: { select: { publishedAt: true } },
          credentials: {
            where: { status: ExamCredentialStatus.ACTIVE },
            select: { id: true, codeHash: true, validFrom: true, validUntil: true, createdAt: true },
          },
        },
      },
    },
  });

  // A learner with their own password no longer signs in with exam passwords.
  const credentials =
    learner?.role === Role.LEARNER && !learner.passwordHash
      ? learner.candidacies.flatMap((c) => c.credentials.map((cred) => ({ ...cred, assessmentId: c.assessmentId, publishedAt: c.assessment.publishedAt })))
      : [];
  const match = await matchCredential(code, credentials, now);

  const fail = async (reason: ExamLoginFailure, extra: { validFrom?: Date } = {}): Promise<ExamLoginResult> => {
    await recordAudit({
      actorId: learner?.id ?? null,
      action: AuditAction.EXAM_LOGIN_FAILED,
      entityType: match ? "ExamCredential" : "User",
      entityId: match?.id ?? learner?.id,
      metadata: { email: normalizedEmail, reason, ...(match ? { assessmentId: match.assessmentId } : {}) },
      ipAddress: meta.ipAddress,
    });
    return { ok: false, reason, ...extra };
  };

  if (!learner || !match) return fail("invalid_credentials");
  if (learner.status !== UserStatus.ACTIVE) return fail("account_disabled");
  if (now < match.validFrom) return fail("not_yet_valid", { validFrom: match.validFrom });

  // Once results are published, the (non-revoked) exam password signs the learner back in to that
  // one assessment to see their result — for RESULTS_ACCESS_DAYS after publication, then it expires.
  // Nothing can be started or answered then: the attempt engine checks the assessment window on
  // every start and save.
  const published = await db.assessment.findUnique({ where: { id: match.assessmentId }, select: { publishedAt: true } });
  if (published?.publishedAt && now >= resultsAccessUntil(published.publishedAt)) return fail("expired");
  const resultsOnly = !!published?.publishedAt;
  if (!resultsOnly) {
    if (now >= match.validUntil) return fail("expired");
    await syncTimeBasedStatuses(now, match.assessmentId);
    const assessment = await db.assessment.findUnique({ where: { id: match.assessmentId }, select: { status: true } });
    if (!assessment || !OPEN_FOR_SIGN_IN.includes(assessment.status)) return fail("assessment_unavailable");
  }

  const { token, expiresAt } = await createSession(learner.id, meta, { examCredentialId: match.id }, now);
  await db.examCredential.update({ where: { id: match.id }, data: { lastUsedAt: now } });
  await recordAudit({
    actorId: learner.id,
    action: AuditAction.EXAM_LOGIN_SUCCEEDED,
    entityType: "ExamCredential",
    entityId: match.id,
    metadata: { assessmentId: match.assessmentId, ...(resultsOnly ? { resultsOnly: true } : {}) },
    ipAddress: meta.ipAddress,
  });

  return {
    ok: true,
    user: { id: learner.id, email: learner.email, name: learner.name, role: learner.role, assessmentId: match.assessmentId },
    token,
    expiresAt,
  };
}
