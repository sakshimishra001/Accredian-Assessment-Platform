import "server-only";
import { AssessmentStatus, AttemptStatus, Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { presenceStore, type Presence } from "../realtime/presence";
import { effectiveDeadline } from "./attempts";

/*
 * Learner presence (proctor dashboard, phase 6): the exam page's heartbeat. Only the learner's own
 * attempt, and only while it is running (in progress, not locked, before its deadline, in a live
 * assessment). Read-only for the database: no proctoring event, no violation, no change to the
 * attempt's timing or lastActivityAt — presence lives in memory only (server/realtime/presence.ts).
 */

/** A page's connection id: a random UUID from the browser (it only tells two exam pages apart). */
const CONNECTION_ID = /^[A-Za-z0-9-]{8,64}$/;

function connectionIdOf(raw: unknown) {
  if (typeof raw !== "string" || !CONNECTION_ID.test(raw)) throw new ValidationError("Invalid connection.");
  return raw;
}

/** Assessments in which an attempt can be running. */
const LIVE: readonly AssessmentStatus[] = [AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED];

/** "Still here": the learner's own running attempt's exam page is open. */
export async function recordPresence(actor: SessionUser, attemptId: string, rawConnectionId: unknown, now: Date = new Date()) {
  assertRole(actor, Role.LEARNER);
  const connectionId = connectionIdOf(rawConnectionId);
  const attempt = await db.assessmentAttempt.findFirst({
    where: ownAttemptWhere(actor.id, attemptId),
    select: {
      id: true,
      assessmentId: true,
      learnerId: true,
      status: true,
      lockedAt: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      assessment: { select: { status: true, timingMode: true, endAt: true, durationMinutes: true, pausedAt: true } },
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  const running =
    attempt.status === AttemptStatus.IN_PROGRESS && !attempt.lockedAt && LIVE.includes(attempt.assessment.status) && now < effectiveDeadline(attempt, attempt.assessment, now);
  if (!running) throw new ConflictError("This attempt is not running.");
  presenceStore.heartbeat({ attemptId: attempt.id, assessmentId: attempt.assessmentId, learnerId: attempt.learnerId, connectionId });
  return { ok: true as const };
}

/** The exam page is closing (best-effort; the offline timeout is the fallback). The learner's own attempt only. */
export async function leavePresence(actor: SessionUser, attemptId: string, rawConnectionId: unknown) {
  assertRole(actor, Role.LEARNER);
  const connectionId = connectionIdOf(rawConnectionId);
  const attempt = await db.assessmentAttempt.findFirst({ where: ownAttemptWhere(actor.id, attemptId), select: { id: true } });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  presenceStore.leave(attempt.id, connectionId);
}

/**
 * A running attempt's presence for the proctor dashboard (callers authorize first). An attempt that
 * isn't running is never shown as online; one never seen by this server is offline with no time.
 */
export function presenceOf(attemptId: string, running: boolean): Presence | { online: false; lastSeenAt: null } {
  const p = presenceStore.get(attemptId);
  if (!p) return { online: false, lastSeenAt: null };
  return running ? p : { online: false, lastSeenAt: p.lastSeenAt };
}
