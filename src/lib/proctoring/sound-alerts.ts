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
 * Proctor: a live monitoring event. The warning sound plays for PROCTORING_VIOLATION only (the server
 * publishes it for counted violations only), when the proctor has switched sound alerts on, and once
 * per event. Events are never replayed (no history on the stream; polling only reloads the page), so
 * the attempt and the server's time identify one.
 */
export function proctorViolationAlert(event: Pick<MonitoringEvent, "type" | "attemptId" | "at">, enabled: boolean, seen: Seen): boolean {
  if (event.type !== "PROCTORING_VIOLATION") return false;
  const fresh = seen.firstTime(`${event.attemptId ?? ""}:${event.at}`);
  return enabled && fresh;
}

/** The proctor's sound preference, kept in this browser only. */
export const PROCTOR_SOUND_KEY = "proctor-sound-alerts";
export const parseSoundPreference = (stored: string | null) => stored === "on";
