/*
 * Proctoring evidence (proctor dashboard, phase 7): the rules shared by the learner's exam page, the
 * server and the proctor dashboard. Evidence is a still JPEG of the learner's camera or shared
 * screen, captured at randomized times while the attempt runs — never video, never continuous. The
 * learner is told before starting (camera / screen requirement notices).
 */

export type EvidenceType = "CAMERA" | "SCREEN";
export const EVIDENCE_TYPES: readonly EvidenceType[] = ["CAMERA", "SCREEN"];

export const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = { CAMERA: "Camera", SCREEN: "Screen" };

/**
 * When snapshots are taken: one at a random time between `minMs` and `maxMs` after the previous one
 * (or after the camera / screen is ready), independently for the camera and the screen.
 */
export const SNAPSHOT_WINDOW = { minMs: 3 * 60_000, maxMs: 5 * 60_000 } as const;

/**
 * Image size and quality — enough to see who is in view / what is on screen, not photography.
 * Camera: at most 640×480, JPEG quality 0.7 (typically 30–80 KB).
 * Screen: at most 1280×800, JPEG quality 0.6 (typically 80–250 KB).
 */
export const SNAPSHOT_FORMAT: Record<EvidenceType, { maxWidth: number; maxHeight: number; quality: number }> = {
  CAMERA: { maxWidth: 640, maxHeight: 480, quality: 0.7 },
  SCREEN: { maxWidth: 1280, maxHeight: 800, quality: 0.6 },
};

/** The largest snapshot the server accepts. */
export const EVIDENCE_MAX_BYTES = 1_000_000;
/** The server refuses a second snapshot of the same type within this long (the client waits 3–5 minutes). */
export const EVIDENCE_MIN_GAP_MS = 60_000;
/** At most this many snapshots of each type per attempt (about 10 hours at the fastest rate). */
export const EVIDENCE_MAX_PER_ATTEMPT = 200;

/** Scale (w, h) down to fit within (maxW, maxH), keeping the aspect ratio; never up. Whole pixels, at least 1. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A JPEG starts with FF D8 FF. */
export function looksLikeJpeg(data: Uint8Array) {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}
