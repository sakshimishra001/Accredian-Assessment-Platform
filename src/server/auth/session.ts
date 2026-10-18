import "server-only";
import { AttemptStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { db } from "../db";
import { env } from "../env";
import { generateSessionToken, hashSessionToken } from "./tokens";

/** The authenticated user as exposed to the rest of the app (never includes the password hash). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * Learner requests only: the assessment this request is about. A learner session authenticates
   * the learner; which assessments they may open is decided by their assignments (candidate rows),
   * checked by every learner service. Pages and actions set it from the route with forAssessment().
   * A legacy session opened with an exam password defaults to that password's assessment — only a
   * default for assessment-level calls made without a route; it is never used to find an attempt,
   * file or result by id (those belong to whichever assessment they belong to: lib/learner/ownership).
   */
  assessmentId?: string;
  /** Legacy learner sessions only: the assessment-specific exam password the session was opened with. */
  examCredentialId?: string;
  /** Learner sessions only: this session's id (attempts record which session started them). */
  sessionId?: string;
}

/**
 * The learner acting on one assessment (from the route). This grants nothing by itself: the learner
 * services only serve an assessment the learner is assigned to, under its window and attempt rules.
 */
export function forAssessment(actor: SessionUser, assessmentId: string): SessionUser & { assessmentId: string } {
  return { ...actor, assessmentId };
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Session lifetimes. Staff sessions (which can change papers, assessments, results and accounts)
 * time out after a short idle period; learner sessions allow a longer pause (reading a long
 * question makes no requests). A legacy exam-password session is also bounded by its credential.
 */
export function sessionPolicy(kind: "staff" | "learner") {
  const e = env();
  return kind === "staff"
    ? { idleMs: e.STAFF_SESSION_IDLE_MINUTES * 60_000, maxMs: e.STAFF_SESSION_MAX_HOURS * 3_600_000 }
    : { idleMs: e.LEARNER_SESSION_IDLE_MINUTES * 60_000, maxMs: e.LEARNER_SESSION_MAX_HOURS * 3_600_000 };
}

/** lastSeenAt is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = 60_000;

/** End of the results-only period of an assessment whose results were published at `publishedAt`. */
export function resultsAccessUntil(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + env().RESULTS_ACCESS_DAYS * 86_400_000);
}

export async function createSession(
  userId: string,
  meta: RequestMeta = {},
  options: { kind?: "staff" | "learner"; examCredentialId?: string } = {},
  now: Date = new Date(),
) {
  const token = generateSessionToken();
  const kind = options.kind ?? (options.examCredentialId ? "learner" : "staff");
  const expiresAt = new Date(now.getTime() + sessionPolicy(kind).maxMs);
  await db.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      examCredentialId: options.examCredentialId ?? null,
      expiresAt,
      lastSeenAt: now,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });
  return { token, expiresAt };
}

/**
 * May this legacy exam-password session continue right now? The exam credential must be active and belong to the
 * learner, and be usable: inside its validity window; or during the results-only period after the
 * assessment's results were published; or while the learner still has an attempt in progress (in
 * full-duration timing an attempt may run past the window's end).
 */
async function learnerSessionAllowed(
  credential: { id: string; status: ExamCredentialStatus; validFrom: Date; validUntil: Date; candidate: { id: string; learnerId: string; assessment: { publishedAt: Date | null } } },
  learnerId: string,
  now: Date,
) {
  if (credential.status !== ExamCredentialStatus.ACTIVE || credential.candidate.learnerId !== learnerId) return false;
  if (now >= credential.validFrom && now < credential.validUntil) return true;
  const { publishedAt } = credential.candidate.assessment;
  if (publishedAt && now < resultsAccessUntil(publishedAt)) return true;
  const open = await db.assessmentAttempt.count({ where: { candidateId: credential.candidate.id, status: AttemptStatus.IN_PROGRESS, deadlineAt: { gt: now } } });
  return open > 0;
}

/**
 * Resolve a cookie token to its user, or null. A session ends (and its row is deleted) when it is
 * past its absolute lifetime, idle for longer than its role allows, its account is disabled, or —
 * for a legacy learner session opened with an exam password — that credential is revoked, expired
 * or out of its results-only period.
 */
export async function validateSessionToken(token: string | undefined | null, now: Date = new Date()): Promise<SessionUser | null> {
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      user: { select: { id: true, email: true, name: true, role: true, status: true } },
      examCredential: {
        select: {
          id: true,
          status: true,
          validFrom: true,
          validUntil: true,
          candidate: { select: { id: true, assessmentId: true, learnerId: true, assessment: { select: { publishedAt: true } } } },
        },
      },
    },
  });
  if (!session) return null;
  const end = async () => {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  };

  const { id, email, name, role, status } = session.user;
  const policy = sessionPolicy(role === Role.LEARNER ? "learner" : "staff");
  if (session.expiresAt.getTime() <= now.getTime()) return end();
  if (now.getTime() - session.lastSeenAt.getTime() > policy.idleMs) return end();
  if (status !== UserStatus.ACTIVE) return end();

  let user: SessionUser;
  if (role !== Role.LEARNER) {
    user = { id, email, name, role };
  } else if (session.examCredentialId) {
    // Legacy: opened with an assessment-specific exam password — valid only while that credential is.
    const credential = session.examCredential;
    if (!credential || !(await learnerSessionAllowed(credential, id, now))) return end();
    user = { id, email, name, role, assessmentId: credential.candidate.assessmentId, examCredentialId: credential.id, sessionId: session.id };
  } else {
    // Opened with the learner's own password: the learner, across their assigned assessments.
    user = { id, email, name, role, sessionId: session.id };
  }

  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: now } });
  }
  return user;
}

export async function invalidateSession(token: string) {
  await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

export async function invalidateAllUserSessions(userId: string) {
  await db.session.deleteMany({ where: { userId } });
}
