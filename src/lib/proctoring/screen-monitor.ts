/*
 * Screen sharing in the learner's exam (proctor dashboard, phase 7), with no DOM of its own (the exam
 * page wires it to getDisplayMedia and the shared track). The learner must actively choose to share
 * — the browser's own picker; nothing here can bypass it. Only still snapshots are ever kept (see
 * snapshot-schedule.ts), never video.
 *
 * It decides when a change is *reported* (as a proctoring event — recorded, never counted as a
 * violation, so it never locks or terminates): sharing started once per start; sharing stopped or
 * permission denied once per occurrence — not again until sharing has started again. Nothing is
 * reported while idle (paused, locked, closing).
 */

import type { ScreenState } from "./monitoring-status";

export type ScreenEventType = "SCREEN_SHARE_STARTED" | "SCREEN_SHARE_STOPPED" | "SCREEN_SHARE_PERMISSION_DENIED";

/** What the learner sees about screen sharing. */
export type ScreenShareStatus = "not-requested" | "requesting" | "sharing" | "denied" | "stopped";

export const SCREEN_STATUS_TEXT: Record<ScreenShareStatus, string> = {
  "not-requested": "Not requested",
  requesting: "Permission requested",
  sharing: "Sharing",
  denied: "Permission denied",
  stopped: "Sharing stopped",
};

/** Why screen sharing couldn't start. */
export type ScreenProblem = "unsupported" | "insecure" | "blocked" | "denied" | "wrong-surface" | "unavailable";

/** Video only, the whole screen preferred, at a modest frame rate (only stills are ever taken). Never audio. */
export const SCREEN_CONSTRAINTS = { audio: false, video: { displaySurface: "monitor", frameRate: { ideal: 5, max: 10 } } } as const;

export function screenProblem(err: unknown): ScreenProblem {
  const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "SecurityError":
      return "blocked";
    default:
      return "unavailable";
  }
}

export const SCREEN_PROBLEM_MESSAGE: Record<ScreenProblem, string> = {
  unsupported: "This browser can’t share your screen. Please use a current desktop browser (for example Chrome, Edge or Firefox) on a computer.",
  insecure: "Screen sharing only works on a secure (https) connection. Please open the assessment from its secure address.",
  blocked: "Screen sharing is blocked on this page. Reload the page and try again; if it keeps happening, contact your administrator.",
  denied: "Screen sharing wasn’t allowed. Select Share screen, choose your entire screen, then select Share (or Allow).",
  "wrong-surface": "Please share your entire screen — not a single window or browser tab. Select Share screen and choose Entire screen.",
  unavailable: "Screen sharing couldn’t be started. Select Share screen to try again.",
};

/** The browser says what was shared: anything but the whole screen is refused (unknown is accepted). */
export function sharedSurfaceOk(settings: { displaySurface?: string } | null | undefined): boolean {
  const s = settings?.displaySurface;
  return !s || s === "monitor";
}

/** The status the proctor sees (null: never requested). */
export function screenStateOf(status: ScreenShareStatus): ScreenState | null {
  return status === "sharing" ? "sharing" : status === "denied" ? "denied" : status === "stopped" ? "stopped" : null;
}

export function createScreenMonitor(opts: { isIdle: () => boolean; report: (type: ScreenEventType) => void }) {
  let status: ScreenShareStatus = "not-requested";
  let stopReported = false;
  let deniedReported = false;
  const report = (type: ScreenEventType) => {
    if (opts.isIdle()) return false;
    opts.report(type);
    return true;
  };
  return {
    requesting() {
      if (status !== "sharing") status = "requesting";
    },
    /** Sharing (re)started: reported once per start. */
    started() {
      if (status === "sharing") return false;
      status = "sharing";
      stopReported = false;
      deniedReported = false;
      return report("SCREEN_SHARE_STARTED");
    },
    /** The shared track ended (the learner stopped sharing, or the source went away): reported once. */
    stopped() {
      if (status !== "sharing") return false;
      status = "stopped";
      if (stopReported) return false;
      stopReported = true;
      return report("SCREEN_SHARE_STOPPED");
    },
    /** The learner declined (or the browser refused): reported once until sharing starts again. */
    denied() {
      if (status === "sharing") return false;
      status = "denied";
      if (deniedReported) return false;
      deniedReported = true;
      return report("SCREEN_SHARE_PERMISSION_DENIED");
    },
    status: () => status,
  };
}
