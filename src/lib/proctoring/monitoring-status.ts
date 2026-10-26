/*
 * The live state of a learner's camera, face check and screen share (proctor dashboard, phase 7),
 * reported by the exam page with its presence heartbeat and shown to proctors. Operational status
 * only: it is never a violation and nothing acts on it (violations are separate proctoring events).
 * null means "not monitored for this assessment".
 */

export type CameraState = "on" | "off" | "denied";
export type FaceState = "one" | "none" | "multiple" | "unavailable";
export type ScreenState = "sharing" | "stopped" | "denied";

export interface MonitoringStatus {
  camera: CameraState | null;
  face: FaceState | null;
  screen: ScreenState | null;
}

export const NO_MONITORING: MonitoringStatus = { camera: null, face: null, screen: null };

const CAMERA: readonly string[] = ["on", "off", "denied"];
const FACE: readonly string[] = ["one", "none", "multiple", "unavailable"];
const SCREEN: readonly string[] = ["sharing", "stopped", "denied"];

/** A status from the browser: exactly these three keys, each a known value or null; anything else is refused (null). */
export function parseMonitoringStatus(raw: unknown): MonitoringStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.some((k) => k !== "camera" && k !== "face" && k !== "screen")) return null;
  const pick = (v: unknown, allowed: readonly string[]) => (v === null || v === undefined ? null : typeof v === "string" && allowed.includes(v) ? v : undefined);
  const camera = pick(r.camera, CAMERA);
  const face = pick(r.face, FACE);
  const screen = pick(r.screen, SCREEN);
  if (camera === undefined || face === undefined || screen === undefined) return null;
  return { camera, face, screen } as MonitoringStatus;
}

export const sameStatus = (a: MonitoringStatus, b: MonitoringStatus) => a.camera === b.camera && a.face === b.face && a.screen === b.screen;

export const CAMERA_STATE_LABEL: Record<CameraState, string> = { on: "On", off: "Off", denied: "Permission denied" };
export const FACE_STATE_LABEL: Record<FaceState, string> = { one: "1 face", none: "No face", multiple: "Multiple faces", unavailable: "Unavailable" };
export const SCREEN_STATE_LABEL: Record<ScreenState, string> = { sharing: "Sharing", stopped: "Stopped", denied: "Permission denied" };
