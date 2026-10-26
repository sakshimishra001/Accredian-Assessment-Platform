import "server-only";
import { AttemptStatus, Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { checkNotificationMessage, type LearnerNotification } from "@/lib/proctoring/notifications";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { emitMonitoringEvent } from "../realtime/publish";
import { effectiveDeadline } from "./attempts";
import { assertCanProctor } from "./proctor-assignments";

/*
 * Proctor → learner notifications (proctor dashboard, phase 8). One-way and informational: a short
 * message from a proctor or administrator to the learner of one running attempt. Sending writes one
 * row and publishes PROCTOR_NOTIFICATION (identifiers only); nothing else changes — no violation,
 * counter, lock, termination, pause, timing, answer or submission is touched.
 *
 * Sending and the history: exactly who may monitor the assessment (assertCanProctor — an
 * administrator, or an active proctor assigned to it; examiners and learners are refused), and only
 * an attempt of *that* assessment; sending also needs the attempt to be running. Reading and
 * acknowledging: the learner, for their own attempt only (any other id is "not found"); staff can't
 * use the learner's reads. The notification row itself is the record of who sent what and when, so
 * no separate audit entry duplicates the message.
 */

/** At most this many notifications per attempt (protects the learner's exam and the database). */
export const MAX_NOTIFICATIONS_PER_ATTEMPT = 100;
/** The learner's exam loads at most this many unread notifications at once. */
const UNREAD_LIMIT = 20;

/** An id from a URL or a request: a non-empty string, or "not found" (an empty id must never widen a lookup). */
function idOf(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw) throw new NotFoundError(`${what} not found.`);
  return raw;
}

/** Send a notification to the learner of one running attempt of an assessment the actor may proctor. */
export async function sendProctorNotification(actor: SessionUser, input: { assessmentId: string; attemptId: string; message: unknown }, now: Date = new Date()) {
  const assessmentId = idOf(input.assessmentId, "Assessment");
  await assertCanProctor(actor, assessmentId);
  const attemptId = idOf(input.attemptId, "Attempt");
  const attempt = await db.assessmentAttempt.findFirst({
    where: { id: attemptId, assessmentId },
    select: {
      id: true,
      assessmentId: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      learner: { select: { id: true, role: true, name: true } },
      assessment: { select: { timingMode: true, endAt: true, durationMinutes: true, pausedAt: true } },
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  if (attempt.learner.role !== Role.LEARNER) throw new NotFoundError("Attempt not found.");
  if (attempt.status !== AttemptStatus.IN_PROGRESS || now >= effectiveDeadline(attempt, attempt.assessment, now)) {
    throw new ConflictError("This attempt is no longer running, so the learner can’t receive notifications.");
  }
  const checked = checkNotificationMessage(input.message);
  if (!checked.ok) throw new ValidationError(checked.error, { message: [checked.error] });
  if ((await db.proctorNotification.count({ where: { attemptId: attempt.id } })) >= MAX_NOTIFICATIONS_PER_ATTEMPT) {
    throw new ConflictError("No more notifications can be sent for this attempt.");
  }

  const notification = await db.proctorNotification.create({
    data: { assessmentId: attempt.assessmentId, attemptId: attempt.id, senderUserId: actor.id, message: checked.message, createdAt: now },
    select: { id: true, createdAt: true },
  });
  // Stored: tell the learner's exam page and the assessment's dashboards (identifiers only).
  emitMonitoringEvent("PROCTOR_NOTIFICATION", attempt.assessmentId, attempt.id, now, { notificationId: notification.id });
  return { learnerName: attempt.learner.name, sentAt: notification.createdAt };
}

/** An attempt's notifications for the proctor's history, newest first (sender name, read state; no ids). */
export async function listAttemptNotifications(actor: SessionUser, assessmentId: string, attemptId: string) {
  await assertCanProctor(actor, idOf(assessmentId, "Assessment"));
  const attempt = await db.assessmentAttempt.findFirst({ where: { id: idOf(attemptId, "Attempt"), assessmentId }, select: { id: true } });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  const rows = await db.proctorNotification.findMany({
    where: { attemptId: attempt.id, assessmentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, message: true, createdAt: true, readAt: true, sender: { select: { name: true, role: true } } },
  });
  return rows.map((r) => ({ message: r.message, sentAt: r.createdAt, readAt: r.readAt, sender: r.sender ? { name: r.sender.name, role: r.sender.role === Role.ADMIN ? "Administrator" : "Proctor" } : null }));
}

export type NotificationHistoryItem = Awaited<ReturnType<typeof listAttemptNotifications>>[number];

/**
 * Who may listen to an attempt's notification stream: its learner, while the attempt is in progress.
 * Returns the stored ids (the stream subscribes to those, never to anything from the browser).
 */
export async function authorizeMyNotificationStream(actor: SessionUser, attemptId: unknown) {
  assertRole(actor, Role.LEARNER);
  const attempt = await db.assessmentAttempt.findFirst({ where: ownAttemptWhere(actor.id, idOf(attemptId, "Attempt")), select: { id: true, assessmentId: true, status: true } });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  if (attempt.status !== AttemptStatus.IN_PROGRESS) throw new ConflictError("This attempt is not running.");
  return { attemptId: attempt.id, assessmentId: attempt.assessmentId };
}

/** The learner's own attempt (any other id is "not found"; staff are refused). */
async function ownAttempt(actor: SessionUser, attemptId: unknown) {
  assertRole(actor, Role.LEARNER);
  const attempt = await db.assessmentAttempt.findFirst({ where: ownAttemptWhere(actor.id, idOf(attemptId, "Attempt")), select: { id: true } });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  return attempt;
}

const learnerView = (r: { id: string; message: string; createdAt: Date }): LearnerNotification => ({ id: r.id, message: r.message, sentAt: r.createdAt.toISOString() });

/** The learner's unread notifications for their own attempt, oldest first (the text and time only — never who sent it). */
export async function listMyUnreadNotifications(actor: SessionUser, attemptId: unknown): Promise<LearnerNotification[]> {
  const attempt = await ownAttempt(actor, attemptId);
  const rows = await db.proctorNotification.findMany({
    where: { attemptId: attempt.id, readAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: UNREAD_LIMIT,
    select: { id: true, message: true, createdAt: true },
  });
  return rows.reverse().map(learnerView);
}

/** One notification of the learner's own attempt (what the stream announced), or "not found". */
export async function getMyNotification(actor: SessionUser, attemptId: unknown, notificationId: unknown): Promise<LearnerNotification & { read: boolean }> {
  const attempt = await ownAttempt(actor, attemptId);
  const row = await db.proctorNotification.findFirst({ where: { id: idOf(notificationId, "Notification"), attemptId: attempt.id }, select: { id: true, message: true, createdAt: true, readAt: true } });
  if (!row) throw new NotFoundError("Notification not found.");
  return { ...learnerView(row), read: row.readAt !== null };
}

/** "Got it": mark one of the learner's own notifications read. Idempotent — the first read time is kept. */
export async function markNotificationRead(actor: SessionUser, attemptId: unknown, notificationId: unknown, now: Date = new Date()) {
  const attempt = await ownAttempt(actor, attemptId);
  const id = idOf(notificationId, "Notification");
  const { count } = await db.proctorNotification.updateMany({ where: { id, attemptId: attempt.id, readAt: null }, data: { readAt: now } });
  if (count === 0 && !(await db.proctorNotification.count({ where: { id, attemptId: attempt.id } }))) throw new NotFoundError("Notification not found.");
  return { ok: true as const };
}
