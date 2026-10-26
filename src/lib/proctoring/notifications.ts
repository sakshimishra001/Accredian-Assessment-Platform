/*
 * Proctor → learner notifications (proctor dashboard, phase 8): the rules shared by the proctor's
 * form, the server and the learner's exam. One-way and informational only — a notification never
 * affects scoring, violations, timing, answers, autosave, locking, termination or submission.
 */

export const NOTIFICATION_MIN_LENGTH = 3;
export const NOTIFICATION_MAX_LENGTH = 300;

/** Quick messages offered to the proctor (a custom message is also allowed). */
export const QUICK_NOTIFICATIONS = [
  "Please stay on the assessment screen.",
  "Please restore camera access.",
  "Please restore screen sharing.",
  "Please ensure your face is clearly visible.",
  "Please ensure only you are visible on camera.",
] as const;

export type NotificationCheck = { ok: true; message: string } | { ok: false; error: string };

/** Trim and check a message (the server always checks again; the form only mirrors it). */
export function checkNotificationMessage(raw: unknown): NotificationCheck {
  if (typeof raw !== "string") return { ok: false, error: "Enter a message." };
  const message = raw.trim();
  if (!message) return { ok: false, error: "Enter a message." };
  if (message.length < NOTIFICATION_MIN_LENGTH) return { ok: false, error: `At least ${NOTIFICATION_MIN_LENGTH} characters.` };
  if (message.length > NOTIFICATION_MAX_LENGTH) return { ok: false, error: `At most ${NOTIFICATION_MAX_LENGTH} characters.` };
  return { ok: true, message };
}

/** Whether the proctor's Send button is enabled: a valid message and no send in flight. */
export const canSendNotification = (draft: string, pending: boolean) => !pending && checkNotificationMessage(draft).ok;

/** What the learner's exam holds: unread notifications, oldest first. */
export interface LearnerNotification {
  id: string;
  message: string;
  /** ISO time it was sent (the server's). */
  sentAt: string;
}

/** The learner shows at most this many unread notifications (the newest prominently, the rest listed). */
export const MAX_SHOWN_NOTIFICATIONS = 5;

/**
 * Merge received notifications into the learner's list: no duplicates (the same one may arrive by
 * the stream and by polling), oldest first, and only the most recent few kept.
 */
export function mergeNotifications(current: readonly LearnerNotification[], incoming: readonly LearnerNotification[], dismissed: ReadonlySet<string> = new Set()): LearnerNotification[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) if (!dismissed.has(n.id)) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.id.localeCompare(b.id)).slice(-MAX_SHOWN_NOTIFICATIONS);
}

/** "Got it": remove it from the list (the server marks it read). */
export const dismissNotification = (current: readonly LearnerNotification[], id: string) => current.filter((n) => n.id !== id);

/** How often the learner's exam checks for notifications: a slow safety net while the stream is live, otherwise more often. */
export const notificationPollMs = (live: boolean) => (live ? 30_000 : 15_000);
