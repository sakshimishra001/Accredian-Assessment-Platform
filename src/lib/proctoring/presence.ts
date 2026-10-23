/*
 * Learner presence timing (proctor dashboard, phase 6), shared by the exam page's heartbeat and the
 * server's presence store. Presence is connection status only — never a proctoring violation.
 */

/** The exam page sends a heartbeat this often. */
export const PRESENCE_HEARTBEAT_MS = 20_000;
/** No heartbeat for this long: offline (three missed heartbeats, so one failed request never is). */
export const PRESENCE_OFFLINE_AFTER_MS = 60_000;
