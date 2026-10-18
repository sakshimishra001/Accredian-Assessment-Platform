/*
 * Expected native dialogs: legitimate exam actions that briefly hand focus to the browser or the
 * operating system — the system file picker (uploading an answer file), a download's save dialog or
 * downloads panel (a supporting document or an uploaded answer), the camera permission prompt. The
 * action announces itself just before it happens, and a focus departure (or a fullscreen exit, which
 * browsers may force for such dialogs) that *starts* while the announcement is open isn't reported.
 *
 * Announcements are narrow so real departures are still caught:
 * - each is short-lived — a file picker or download that never takes focus stops covering after a
 *   few seconds; a permission prompt covers only while the browser's request is pending;
 * - once the learner is back, the announcement is spent (one dialog, one excused departure);
 * - the page becoming hidden (another tab, a minimised window) is never excused: native dialogs
 *   take focus but don't hide the exam.
 */

export type ExpectedInteraction = "file-picker" | "download" | "permission-prompt";

/** A departure the monitors are about to report: lost focus, a fullscreen exit, or the page hidden. */
export type DepartureKind = "blur" | "fullscreen" | "hidden";

/**
 * How long after the action its dialog can still open. A file picker opens at once; a save dialog
 * opens when the download starts. The permission prompt is open until the request settles (no limit).
 */
export const EXPECTED_WINDOW_MS: Record<ExpectedInteraction, number | null> = {
  "file-picker": 3_000,
  download: 5_000,
  "permission-prompt": null,
};

export function createExpectedInteractions(now: () => number = () => Date.now()) {
  const open = new Map<number, { kind: ExpectedInteraction; until: number | null; used: boolean }>();
  let seq = 0;
  const prune = () => {
    const t = now();
    for (const [id, s] of open) if (s.until !== null && t > s.until) open.delete(id);
  };
  return {
    /** An action that may open a native dialog is starting. Returns `end` for when it is over. */
    expect(kind: ExpectedInteraction): () => void {
      const id = ++seq;
      const ms = EXPECTED_WINDOW_MS[kind];
      open.set(id, { kind, until: ms === null ? null : now() + ms, used: false });
      return () => void open.delete(id);
    },
    /** A departure is starting: is it an announced native dialog? (Never for a hidden page.) */
    covers(departure: DepartureKind): boolean {
      if (departure === "hidden") return false;
      prune();
      if (open.size === 0) return false;
      for (const s of open.values()) s.used = true;
      return true;
    },
    /** The learner is back in the exam: dialogs that took them away are over. */
    back() {
      for (const [id, s] of open) if (s.used && s.until !== null) open.delete(id);
    },
    /** Whether anything is announced right now (for tests and diagnostics). */
    pending: () => (prune(), open.size),
  };
}

export type ExpectedInteractions = ReturnType<typeof createExpectedInteractions>;

/** The page's announcements: the exam's file, download and camera controls write here; its monitors read here. */
export const expectedInteractions = createExpectedInteractions();

/** Announce a native dialog the learner is about to open (no effect unless the exam is monitoring). */
export const expectNativeDialog = (kind: ExpectedInteraction) => expectedInteractions.expect(kind);
