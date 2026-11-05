import { isViolation } from "./config";
import type { MonitoringEvent } from "./monitoring-events";

/*
 * When an audio alert plays (proctor dashboard, phase 8 add-on) — decisions only, no audio here
 * (see lib/audio/alert-tones.ts). Sounds are cues and nothing else: they never affect the exam,
 * the violation rules or the dashboard. Every decision is de-duplicated by a stable identifier, so
 * the same violation or notification never sounds twice — whether it arrives again by polling, an
 * SSE reconnect, a re-render or React Strict Mode's double effects.
 */

type EventType = Parameters<typeof isViolation>[0];

/** A bounded "seen" set: `firstTime(key)` is true only the first time a key is offered. */
export function createSeen(max = 500) {
  const keys = new Set<string>();
  return {
    firstTime(key: string) {
      if (keys.has(key)) return false;
      keys.add(key);
      // Bounded: the oldest keys go first (a long exam or dashboard never grows without limit).
      if (keys.size > max) keys.delete(keys.values().next().value as string);
      return true;
    },
    has: (key: string) => keys.has(key),
  };
}

export type Seen = ReturnType<typeof createSeen>;

/**
 * Learner: the server's answer to a reported event. The warning sound plays only for a *counted*
 * security violation (focus / tab, fullscreen, clipboard) — never for camera, face, screen, evidence
 * or presence events, which are never counted — and once per violation (its number is unique per attempt).
 */
export function learnerViolationAlert(
  eventType: EventType,
  result: { recorded: boolean; outcome: string; violations: number },
  seen: Seen,
): boolean {
  if (!isViolation(eventType) || !result.recorded) return false;
  if (result.outcome !== "WARNING" && result.outcome !== "LOCKED" && result.outcome !== "TERMINATED") return false;
  return seen.firstTime(`violation:${result.violations}`);
}

/**
 * Learner: notifications just received (by the stream, a poll or the initial load). The chime plays
 * once when at least one is new. What the page finds when it opens (or reopens after a refresh) is
 * already there — it is marked seen without a sound (`primed` false until that first load is done).
 */
export function notificationChime(ids: readonly string[], seen: Seen, primed: boolean): boolean {
  let fresh = false;
  for (const id of ids) if (seen.firstTime(`notification:${id}`)) fresh = true;
  return primed && fresh;
}

/**
 * Proctor: a live monitoring event. Only PROCTORING_VIOLATION alerts (the server publishes it for
 * counted violations only), once per event — identified by its proctoring event id (or, for an older
 * server, the attempt and time). Events are never replayed (no history on the stream; polling only
 * reloads the page), so nothing from before the page loaded alerts. The visual alert always shows;
 * the sound only when the proctor has switched sound alerts on.
 */
export function proctorViolationDecision(event: Pick<MonitoringEvent, "type" | "attemptId" | "at" | "eventId">, soundEnabled: boolean, seen: Seen): { visual: boolean; sound: boolean } {
  if (event.type !== "PROCTORING_VIOLATION") return { visual: false, sound: false };
  const fresh = seen.firstTime(event.eventId ? `event:${event.eventId}` : `${event.attemptId ?? ""}:${event.at}`);
  return { visual: fresh, sound: fresh && soundEnabled };
}

/** The sound part of the proctor's decision (kept for callers that only need the sound). */
export const proctorViolationAlert = (event: Pick<MonitoringEvent, "type" | "attemptId" | "at" | "eventId">, enabled: boolean, seen: Seen) =>
  proctorViolationDecision(event, enabled, seen).sound;

/** What the alerts say happened, per counted violation type. */
export const VIOLATION_ALERT_TEXT: Record<string, string> = {
  FOCUS_LOST: "Tab or window switch detected",
  FULLSCREEN_EXIT: "Fullscreen exit detected",
  CLIPBOARD_COPY: "Copy detected",
  CLIPBOARD_CUT: "Cut detected",
  CLIPBOARD_PASTE: "Paste detected",
};

/** The learner's on-screen alert for a counted violation (shown together with the sound). */
export interface LearnerViolationNotice {
  key: string;
  what: string;
  violation: number;
  max: number;
  outcome: string;
}

/**
 * Learner: the sound and the on-screen PROCTORING ALERT, together, for a newly counted violation —
 * the same rule as learnerViolationAlert (counted security violations only, once per violation
 * number). Null when nothing should alert.
 */
export function learnerViolationNotice(
  eventType: EventType,
  result: { recorded: boolean; outcome: string; violations: number; maxViolations: number },
  seen: Seen,
): LearnerViolationNotice | null {
  if (!learnerViolationAlert(eventType, result, seen)) return null;
  return { key: `violation:${result.violations}`, what: VIOLATION_ALERT_TEXT[eventType] ?? "Proctoring violation detected", violation: result.violations, max: result.maxViolations, outcome: result.outcome };
}

/** The proctor's on-screen violation alert. Filled in from the authorized event details once fetched. */
export interface ProctorViolationNotice {
  key: string;
  attemptId: string;
  at: string;
  learnerName: string | null;
  what: string;
  violation: number | null;
  max: number | null;
}

/** At most this many proctor alerts are shown at once (the newest first); older ones drop off. */
export const MAX_PROCTOR_ALERTS = 4;

/** Add or update an alert: the newest first, no duplicates, a few at most. Alerts stay until dismissed. */
export function upsertAlert<T extends { key: string }>(list: readonly T[], alert: T, max = MAX_PROCTOR_ALERTS): T[] {
  const rest = list.filter((a) => a.key !== alert.key);
  const existing = list.find((a) => a.key === alert.key);
  return existing ? list.map((a) => (a.key === alert.key ? alert : a)) : [alert, ...rest].slice(0, max);
}

/** The proctor's sound preference, kept in this browser only. */
export const PROCTOR_SOUND_KEY = "proctor-sound-alerts";
export const parseSoundPreference = (stored: string | null) => stored === "on";
