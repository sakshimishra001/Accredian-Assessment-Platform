import "server-only";
import { Role } from "@/generated/prisma/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { NO_MONITORING, parseMonitoringStatus, type MonitoringStatus } from "@/lib/proctoring/monitoring-status";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { presenceStore, type Presence } from "../realtime/presence";
import { findOwnRunningAttempt } from "./running-attempt";

/*
 * Learner presence (proctor dashboard, phase 6): the exam page's heartbeat. Only the learner's own
 * attempt, and only while it is running (in progress, not locked, before its deadline, in a live
 * assessment). Read-only for the database: no proctoring event, no violation, no change to the
 * attempt's timing or lastActivityAt — presence lives in memory only (server/realtime/presence.ts).
 * Since phase 7 the heartbeat also carries the camera / face / screen state for the proctor (status
 * only, never a violation).
 */

/** A page's connection id: a random UUID from the browser (it only tells two exam pages apart). */
const CONNECTION_ID = /^[A-Za-z0-9-]{8,64}$/;

function connectionIdOf(raw: unknown) {
  if (typeof raw !== "string" || !CONNECTION_ID.test(raw)) throw new ValidationError("Invalid connection.");
  return raw;
}

/** "Still here": the learner's own running attempt's exam page is open (with its camera / face / screen state, if sent). */
export async function recordPresence(actor: SessionUser, attemptId: string, rawConnectionId: unknown, now: Date = new Date(), rawStatus?: unknown) {
  assertRole(actor, Role.LEARNER);
  const connectionId = connectionIdOf(rawConnectionId);
  const status = rawStatus === undefined ? undefined : parseMonitoringStatus(rawStatus);
  if (status === null) throw new ValidationError("Invalid monitoring status.");
  const attempt = await findOwnRunningAttempt(actor, attemptId, now);
  presenceStore.heartbeat({ attemptId: attempt.id, assessmentId: attempt.assessmentId, learnerId: attempt.learnerId, connectionId }, status);
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
 * isn't running is never shown as online, and its camera / screen state isn't shown as current; one
 * never seen by this server is offline with no time.
 */
export function presenceOf(attemptId: string, running: boolean): Presence | { online: false; lastSeenAt: null; status: MonitoringStatus } {
  const p = presenceStore.get(attemptId);
  if (!p) return { online: false, lastSeenAt: null, status: NO_MONITORING };
  return running ? p : { online: false, lastSeenAt: p.lastSeenAt, status: NO_MONITORING };
}
