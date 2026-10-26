import type { FocusViolationAction, ProctoringAction, ProctoringEventType, ProctoringSeverity } from "@/generated/prisma/enums";

/*
 * Proctoring configuration rules, shared by the server (what is recorded and enforced) and the
 * admin screens (what is shown as active). Nothing here detects anything: it only decides which
 * controls are in force and how an event is classified.
 */

export interface ProctoringSettings {
  proctoringEnabled: boolean;
  focusMonitoringEnabled: boolean;
  fullscreenEnabled: boolean;
  clipboardMonitoringEnabled: boolean;
  cameraRequired: boolean;
  faceDetectionEnabled: boolean;
  multipleFaceDetectionEnabled: boolean;
  faceMissingDetectionEnabled: boolean;
  /** Periodic camera snapshots kept as proctoring evidence (phase 7; only with the camera required). */
  cameraSnapshotsEnabled: boolean;
  /** Screen sharing with periodic screen snapshots kept as proctoring evidence (phase 7). */
  screenMonitoringEnabled: boolean;
}

/**
 * The controls actually in force. The master switch gates everything; camera detections need the
 * camera to be required (saved detection settings never turn the camera on by themselves), and
 * the multiple-face / face-missing checks are parts of face detection.
 */
export function effectiveProctoring(s: ProctoringSettings) {
  const on = s.proctoringEnabled;
  const camera = on && s.cameraRequired;
  const face = camera && s.faceDetectionEnabled;
  return {
    enabled: on,
    focus: on && s.focusMonitoringEnabled,
    fullscreen: on && s.fullscreenEnabled,
    clipboard: on && s.clipboardMonitoringEnabled,
    camera,
    faceDetection: face,
    multipleFaces: face && s.multipleFaceDetectionEnabled,
    faceMissing: face && s.faceMissingDetectionEnabled,
    cameraSnapshots: camera && s.cameraSnapshotsEnabled,
    screen: on && s.screenMonitoringEnabled,
  };
}

export type EffectiveProctoring = ReturnType<typeof effectiveProctoring>;

/**
 * The camera requirement as the learner's exam needs it, or null when the camera isn't in force.
 * Face detection is included only when in force: `missing` / `multiple` say which face events are
 * reported (the server applies eventEnabled again to every event). Nothing else is exposed.
 */
export function learnerCameraConfig(a: ProctoringSettings & { focusMaxViolations: number; focusViolationAction: FocusViolationAction }) {
  const p = effectiveProctoring(a);
  if (!p.camera) return null;
  return {
    maxViolations: a.focusMaxViolations,
    action: a.focusViolationAction,
    faceDetection: p.faceDetection ? { missing: p.faceMissing, multiple: p.multipleFaces } : null,
    /** Periodic snapshots are captured as evidence (the learner is told before starting). */
    snapshots: p.cameraSnapshots,
  };
}

/** Screen monitoring as the learner's exam needs it (sharing + periodic snapshots), or null when it isn't in force. */
export function learnerScreenConfig(a: ProctoringSettings) {
  return effectiveProctoring(a).screen ? { snapshots: true as const } : null;
}

/** System events describe the session. */
export const SYSTEM_EVENTS: readonly ProctoringEventType[] = ["PROCTORING_STARTED", "PROCTORING_STOPPED"];
/**
 * The security violations that count towards the assessment's violation limit (and so can lead to
 * its WARN / LOCK / TERMINATE action): leaving the exam, leaving fullscreen, clipboard use. Only these.
 */
export const LIMIT_VIOLATIONS: readonly ProctoringEventType[] = ["FOCUS_LOST", "FULLSCREEN_EXIT", "CLIPBOARD_COPY", "CLIPBOARD_CUT", "CLIPBOARD_PASTE"];
/**
 * Proctoring observations: camera, face and screen availability and state (camera off / permission
 * revoked, no face, several faces, screen sharing stopped / denied, camera connected, sharing
 * started). Recorded for the proctor's dashboard and the attempt timeline, never counted — so they
 * never lead to a lock or termination on their own. The proctor decides what to do.
 */
export const NOTICE_EVENTS: readonly ProctoringEventType[] = [
  "CAMERA_DISABLED",
  "CAMERA_PERMISSION_REVOKED",
  "FACE_NOT_DETECTED",
  "MULTIPLE_FACES",
  "CAMERA_CONNECTED",
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_STOPPED",
  "SCREEN_SHARE_PERMISSION_DENIED",
];
/** Whether an event counts towards the violation limit (an explicit list: a new event type never counts by default). */
export const isViolation = (type: ProctoringEventType) => LIMIT_VIOLATIONS.includes(type);

/** Whether an event of this type can be recorded under the controls in force. */
export function eventEnabled(type: ProctoringEventType, p: EffectiveProctoring): boolean {
  switch (type) {
    case "FOCUS_LOST":
      return p.focus;
    case "FULLSCREEN_EXIT":
      return p.fullscreen;
    case "CLIPBOARD_COPY":
    case "CLIPBOARD_CUT":
    case "CLIPBOARD_PASTE":
      return p.clipboard;
    case "CAMERA_DISABLED":
    case "CAMERA_PERMISSION_REVOKED":
    case "CAMERA_CONNECTED":
      return p.camera;
    case "SCREEN_SHARE_STARTED":
    case "SCREEN_SHARE_STOPPED":
    case "SCREEN_SHARE_PERMISSION_DENIED":
      return p.screen;
    case "FACE_NOT_DETECTED":
      return p.faceMissing;
    case "MULTIPLE_FACES":
      return p.multipleFaces;
    case "PROCTORING_STARTED":
    case "PROCTORING_STOPPED":
      return p.enabled;
  }
}

/** Clipboard operations: only the fact that one happened is ever recorded — never what was copied or pasted. */
export const CLIPBOARD_EVENTS: readonly ProctoringEventType[] = ["CLIPBOARD_COPY", "CLIPBOARD_CUT", "CLIPBOARD_PASTE"];

/**
 * A fixed severity per event (no risk scoring): high when it led to a lock or termination. Camera
 * and face observations keep their severity although they no longer count.
 */
export function eventSeverity(type: ProctoringEventType, action: ProctoringAction | null): ProctoringSeverity {
  if (action === "LOCK" || action === "TERMINATE") return "HIGH";
  switch (type) {
    case "MULTIPLE_FACES":
    case "CAMERA_PERMISSION_REVOKED":
      return "HIGH";
    case "FACE_NOT_DETECTED":
    case "CAMERA_DISABLED":
    case "SCREEN_SHARE_STOPPED":
    case "SCREEN_SHARE_PERMISSION_DENIED":
      return "MEDIUM";
  }
  return isViolation(type) ? "MEDIUM" : "LOW";
}

/** The policy's action (WARN / LOCK / TERMINATE) as recorded on the event. */
export const ACTION_TAKEN: Record<FocusViolationAction, ProctoringAction> = { WARN: "WARNING", LOCK: "LOCK", TERMINATE: "TERMINATE" };

export const VIOLATION_ACTION_LABEL: Record<FocusViolationAction, string> = { WARN: "warn", LOCK: "lock the exam", TERMINATE: "terminate the exam" };

export const PROCTORING_EVENT_LABEL: Record<ProctoringEventType, string> = {
  FOCUS_LOST: "Left the exam (focus lost)",
  FULLSCREEN_EXIT: "Exited fullscreen",
  CLIPBOARD_COPY: "Clipboard copy",
  CLIPBOARD_CUT: "Clipboard cut",
  CLIPBOARD_PASTE: "Clipboard paste",
  FACE_NOT_DETECTED: "Face not detected",
  MULTIPLE_FACES: "Multiple faces",
  CAMERA_DISABLED: "Camera turned off",
  CAMERA_PERMISSION_REVOKED: "Camera permission revoked",
  PROCTORING_STARTED: "Proctoring started",
  PROCTORING_STOPPED: "Proctoring stopped",
  CAMERA_CONNECTED: "Camera connected",
  SCREEN_SHARE_STARTED: "Screen sharing started",
  SCREEN_SHARE_STOPPED: "Screen sharing stopped",
  SCREEN_SHARE_PERMISSION_DENIED: "Screen sharing permission denied",
};
