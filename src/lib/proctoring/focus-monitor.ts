import type { ExpectedInteractions } from "./expected-interactions";

/*
 * Focus monitoring in the browser, as a small state machine with no DOM of its own (the exam screen
 * wires it to visibilitychange / blur / focus). It only decides when a departure is *reported*; the
 * server decides whether it counts, the violation number and any action.
 *
 * A departure is the page becoming hidden (another tab, a minimised window) — reported at once — or
 * the window losing focus for longer than a short grace period (another app or window). Not
 * departures: focus moving into an in-app frame (the PDF preview), and a native dialog the exam itself
 * opened and announced (file picker, download, camera prompt — see expected-interactions.ts). One
 * departure is reported once, until the learner is back. Nothing is reported while idle.
 */

/** A blur only counts if the page still lacks focus after this (clicks into frames, pickers). */
export const BLUR_GRACE_MS = 1_000;

export function createFocusMonitor(opts: {
  isIdle: () => boolean;
  /** The window (including the exam's own frames) has focus. */
  hasFocus: () => boolean;
  /** Focus is inside one of the exam's own frames (e.g. the PDF preview). */
  focusInFrame: () => boolean;
  isVisible: () => boolean;
  expected: ExpectedInteractions;
  onLeave: () => void;
  onBack: () => void;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let away = false;
  let blurTimer: unknown = null;
  const cancel = () => {
    if (blurTimer !== null) clearTimer(blurTimer);
    blurTimer = null;
  };
  function leave() {
    if (away || opts.isIdle()) return;
    away = true;
    opts.onLeave();
  }
  function back() {
    away = false;
    opts.expected.back();
    opts.onBack();
  }
  return {
    visibilityChange() {
      if (opts.isVisible()) back();
      else leave();
    },
    blur() {
      cancel();
      // Decided when focus leaves: an announced native dialog opening now isn't leaving the exam.
      const expected = opts.expected.covers("blur");
      blurTimer = setTimer(() => {
        blurTimer = null;
        if (expected || opts.focusInFrame()) return;
        if (!opts.hasFocus()) leave();
      }, opts.graceMs ?? BLUR_GRACE_MS);
    },
    focus() {
      cancel();
      if (opts.isVisible()) back();
    },
    dispose: cancel,
  };
}
