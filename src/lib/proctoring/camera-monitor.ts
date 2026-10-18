/*
 * Camera readiness and loss in the browser, with no DOM of its own (the learner's exam screens wire
 * it to getUserMedia and the camera track). It never sees a frame: the stream is only shown back to
 * the learner on their own screen — nothing is recorded, uploaded or stored, and no microphone is
 * ever requested. It only decides when a camera loss is *reported*; the server decides whether it
 * counts, the violation number and any action.
 *
 * One loss is reported once: a revoked permission and the track ending that follows it are the same
 * loss, so after reporting nothing more is reported until the camera check has been passed again. A
 * loss while the monitor is idle (paused, locked, closing) is never reported — and isn't reported
 * later either: the learner is simply asked to turn the camera back on.
 */

export type CameraEventType = "CAMERA_DISABLED" | "CAMERA_PERMISSION_REVOKED";

/** Why the camera check failed. */
export type CameraProblem = "unsupported" | "insecure" | "blocked" | "denied" | "not-found" | "unavailable";

/** Video only — never audio. A modest resolution: the preview is all it is used for. */
export const CAMERA_CONSTRAINTS = { audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } } as const;

/** What a failed getUserMedia call means for the learner (by the DOMException name). */
export function cameraProblem(err: unknown): CameraProblem {
  const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "SecurityError":
      return "blocked";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "not-found";
    default:
      // NotReadableError / TrackStartError (in use by another app), AbortError, anything else.
      return "unavailable";
  }
}

export const CAMERA_PROBLEM_MESSAGE: Record<CameraProblem, string> = {
  unsupported: "This browser can’t use a camera. Please use a current desktop browser (for example Chrome, Edge, Firefox or Safari) on a computer with a camera.",
  insecure: "The camera can only be used on a secure (https) connection. Please open the assessment from its secure address.",
  blocked: "Camera access is blocked on this page. Reload the page and try again; if it keeps happening, contact your administrator.",
  denied: "Camera access was denied. Allow the camera for this site (use the camera icon in the address bar or your browser’s site settings), then select Try again.",
  "not-found": "No camera was found. Connect a camera (or enable the built-in one), then select Try again.",
  unavailable: "The camera couldn’t be started — it may be in use by another app or turned off. Close other apps using the camera, then select Try again.",
};

/** Whether a stream still has a working video track. */
export function streamIsLive(stream: { getVideoTracks(): { readyState: string }[] } | null | undefined): boolean {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === "live");
}

/**
 * The event for a lost camera, from the camera permission's state at that moment: no longer granted
 * means the permission was revoked; still granted (or unknown) means the camera itself went away.
 */
export function cameraLossType(permission: PermissionState | null): CameraEventType {
  return permission === "denied" || permission === "prompt" ? "CAMERA_PERMISSION_REVOKED" : "CAMERA_DISABLED";
}

export function createCameraMonitor(opts: { isIdle: () => boolean; onLoss: (type: CameraEventType) => void }) {
  /** The camera check has been passed since the last loss was handled (only then can a loss count). */
  let live = false;
  return {
    /** The camera check was passed: the camera is on. */
    ready() {
      live = true;
    },
    /** The camera went away. Returns whether the loss was reported. */
    lost(type: CameraEventType) {
      if (!live) return false;
      live = false;
      if (opts.isIdle()) return false;
      opts.onLoss(type);
      return true;
    },
    isLive: () => live,
  };
}
