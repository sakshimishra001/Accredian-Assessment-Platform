/*
 * Fullscreen enforcement in the browser, as a small state machine with no DOM of its own (the exam
 * screen wires it to the Fullscreen API). It only decides when an exit is *reported*; the server
 * decides whether it counts, the violation number and any action.
 *
 * One physical exit is reported once: browsers can fire fullscreenchange (and visibility / focus
 * events) several times for it, so after reporting, nothing more is reported until the learner is
 * back in fullscreen. An exit while the monitor is idle (paused, locked, closing) is never reported —
 * and isn't reported later either: after a resume the learner is simply asked to return. The same
 * goes for an exit the browser forces for a native dialog the exam itself opened and announced
 * (e.g. Chromium leaves fullscreen to show the file picker): not reported, but fullscreen is still
 * required again.
 */

export type FullscreenState = "in" | "out" | "exited";

export function createFullscreenMonitor(opts: { isFullscreen: () => boolean; isIdle: () => boolean; onExit: () => void; /** The exit comes with an announced native dialog. */ isExpected?: () => boolean }) {
  /** In fullscreen since the last exit was handled (only then can leaving it count). */
  let entered = opts.isFullscreen();
  return {
    /** Call on every fullscreenchange, and after a pause ends. Returns the state the screen should show. */
    sync(): FullscreenState {
      if (opts.isFullscreen()) {
        entered = true;
        return "in";
      }
      if (!entered) return "out";
      entered = false;
      if (opts.isIdle() || opts.isExpected?.()) return "out";
      opts.onExit();
      return "exited";
    },
  };
}

export type FullscreenResult = "ok" | "unsupported" | "denied";

/**
 * Start the exam only once fullscreen is on. `entering` is the fullscreen request already made from
 * the learner's click (null when fullscreen isn't required); `start` is never called unless the
 * browser reported success.
 */
export async function startAfterFullscreen<T>(entering: Promise<FullscreenResult> | null, start: () => Promise<T>): Promise<{ started: true; result: T } | { started: false; reason: Exclude<FullscreenResult, "ok"> }> {
  if (entering) {
    const entered = await entering;
    if (entered !== "ok") return { started: false, reason: entered };
  }
  return { started: true, result: await start() };
}

export type DepartureSource = "focus" | "fullscreen" | "camera" | "face";

/**
 * Departures shared by focus monitoring, fullscreen, the camera and face detection (a missing face):
 * one incident until the learner is fully back (e.g. leaving fullscreen to re-allow a revoked camera,
 * or walking away while the exam also loses focus, counts once, not twice).
 */
export function createDepartureTracker(newId: () => string) {
  let current: { id: string; away: Set<string> } | null = null;
  return {
    /** The incident for a departure noticed by `source` (the same id while any source is still away). */
    leave(source: DepartureSource) {
      current ??= { id: newId(), away: new Set() };
      current.away.add(source);
      return current.id;
    },
    back(source: DepartureSource) {
      if (!current) return;
      current.away.delete(source);
      if (current.away.size === 0) current = null;
    },
  };
}
