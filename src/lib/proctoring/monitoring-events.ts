/*
 * Live monitoring events (proctor dashboard, phase 5) — shared by the server's event bus and the
 * proctor dashboard's client. An event says only *that* an attempt (or the assessment) changed; the
 * dashboard then reloads the authoritative state from the server.
 */

export const MONITORING_EVENT_TYPES = [
  "ATTEMPT_STARTED",
  "ATTEMPT_SUBMITTED",
  "ATTEMPT_AUTO_SUBMITTED",
  "PROCTORING_VIOLATION",
  "ATTEMPT_LOCKED",
  "ATTEMPT_TERMINATED",
  "ATTEMPT_PAUSED",
  "ATTEMPT_RESUMED",
  "ATTEMPT_TIME_EXTENDED",
  // Learner presence (phase 6): connection status only, never a violation.
  "LEARNER_ONLINE",
  "LEARNER_OFFLINE",
  // Proctoring evidence (phase 7): a snapshot was stored / camera, face or screen state changed.
  "PROCTORING_EVIDENCE_AVAILABLE",
  "PROCTORING_STATUS_CHANGED",
  // Proctor → learner notification (phase 8): one was sent (its text is fetched separately, authorized).
  "PROCTOR_NOTIFICATION",
] as const;

export type MonitoringEventType = (typeof MONITORING_EVENT_TYPES)[number];

/** What a subscriber learns: which assessment (and attempt, if any) changed, how and when. No learner data. */
export interface MonitoringEvent {
  type: MonitoringEventType;
  assessmentId: string;
  /** The attempt concerned; null for assessment-wide changes (pause / resume). */
  attemptId: string | null;
  /** Server time, ISO 8601. */
  at: string;
  /** PROCTORING_EVIDENCE_AVAILABLE only: which snapshot (never its image or a URL). */
  evidenceId?: string;
  evidenceType?: "CAMERA" | "SCREEN";
  /** PROCTOR_NOTIFICATION only: which notification (never its text). */
  notificationId?: string;
}

/** Control messages on the stream (not monitoring events). */
export const STREAM_SNAPSHOT = "SNAPSHOT";
export const STREAM_REVOKED = "REVOKED";

/** Does this event change what a page shows? An assessment page: any of its events; an attempt page: its attempt's, or assessment-wide ones. */
export function affectsView(event: Pick<MonitoringEvent, "attemptId">, attemptId?: string | null) {
  return !attemptId || !event.attemptId || event.attemptId === attemptId;
}

export type LiveStatus = "connecting" | "live" | "polling";

/**
 * How often the dashboard still polls. While the stream is live, a slow safety net (events published
 * by another server instance never reach this one); otherwise the normal polling interval.
 */
export function pollIntervalMs(status: LiveStatus) {
  return status === "live" ? 60_000 : 20_000;
}
