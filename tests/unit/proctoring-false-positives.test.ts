import { describe, expect, it, vi } from "vitest";
import { createExpectedInteractions, EXPECTED_WINDOW_MS } from "@/lib/proctoring/expected-interactions";
import { BLUR_GRACE_MS, createFocusMonitor } from "@/lib/proctoring/focus-monitor";
import { createFullscreenMonitor } from "@/lib/proctoring/fullscreen-monitor";

/*
 * Legitimate exam actions (supporting documents, answer uploads, the camera prompt, in-app dialogs)
 * must not be reported as leaving the exam — while real departures (another tab, another app,
 * leaving fullscreen) still are.
 */

function exam() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const env = { focus: true, visible: true, frame: false, idle: false, fullscreen: true };
  const expected = createExpectedInteractions(() => now);
  const focusLeft = vi.fn();
  const fullscreenExit = vi.fn();
  const focus = createFocusMonitor({
    isIdle: () => env.idle,
    hasFocus: () => env.focus,
    focusInFrame: () => env.frame,
    isVisible: () => env.visible,
    expected,
    onLeave: focusLeft,
    onBack: () => {},
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => void timers.delete(t as { at: number; fn: () => void }),
  });
  const fullscreen = createFullscreenMonitor({ isFullscreen: () => env.fullscreen, isIdle: () => env.idle, isExpected: () => expected.covers("fullscreen"), onExit: fullscreenExit });
  function advance(ms: number) {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > now) continue;
      timers.delete(t);
      t.fn();
    }
  }
  return {
    env,
    expected,
    focusLeft,
    fullscreenExit,
    advance,
    /** The window loses focus (another app, a native dialog, browser UI). */
    blur() {
      env.focus = false;
      focus.blur();
    },
    /** Focus comes back to the exam. */
    refocus() {
      env.focus = true;
      focus.focus();
    },
    hide() {
      env.visible = false;
      focus.visibilityChange();
    },
    show() {
      env.visible = true;
      focus.visibilityChange();
    },
    exitFullscreen() {
      env.fullscreen = false;
      return fullscreen.sync();
    },
    enterFullscreen() {
      env.fullscreen = true;
      return fullscreen.sync();
    },
  };
}

describe("real departures are still reported", () => {
  it("switching to another app or window (focus lost past the grace period)", () => {
    const e = exam();
    e.blur();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
  });

  it("switching to another tab or minimising (page hidden) — at once, even with a dialog announced", () => {
    const e = exam();
    e.expected.expect("file-picker");
    e.expected.expect("download");
    e.expected.expect("permission-prompt");
    e.hide();
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
  });

  it("leaving fullscreen", () => {
    const e = exam();
    expect(e.exitFullscreen()).toBe("exited");
    expect(e.fullscreenExit).toHaveBeenCalledTimes(1);
  });

  it("one departure is reported once until the learner is back, then the next one counts", () => {
    const e = exam();
    e.hide();
    e.blur();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
    e.show();
    e.refocus();
    e.blur();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(2);
  });

  it("nothing is reported while paused, locked or closing", () => {
    const e = exam();
    e.env.idle = true;
    e.blur();
    e.advance(BLUR_GRACE_MS);
    e.hide();
    expect(e.exitFullscreen()).toBe("out");
    expect(e.focusLeft).not.toHaveBeenCalled();
    expect(e.fullscreenExit).not.toHaveBeenCalled();
  });
});

describe("legitimate exam actions are not violations", () => {
  it("a momentary blur (a click that briefly moves focus) is ignored", () => {
    const e = exam();
    e.blur();
    e.advance(BLUR_GRACE_MS - 1);
    e.refocus();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).not.toHaveBeenCalled();
  });

  it("previewing a supporting document or answer file in the in-app viewer (focus inside its frame)", () => {
    const e = exam();
    e.env.frame = true;
    e.blur(); // the PDF viewer frame takes focus
    e.advance(60_000);
    expect(e.focusLeft).not.toHaveBeenCalled();
  });

  it("uploading or replacing an answer file: the system file picker — however long it stays open", () => {
    const e = exam();
    e.expected.expect("file-picker");
    e.advance(200);
    e.blur();
    e.advance(5 * 60_000);
    e.refocus();
    expect(e.focusLeft).not.toHaveBeenCalled();
  });

  it("the file picker's forced fullscreen exit isn't a violation, but fullscreen is still required again", () => {
    const e = exam();
    e.expected.expect("file-picker");
    expect(e.exitFullscreen()).toBe("out"); // Chromium leaves fullscreen to show the picker
    e.blur();
    e.advance(30_000);
    e.refocus();
    expect(e.fullscreenExit).not.toHaveBeenCalled();
    expect(e.focusLeft).not.toHaveBeenCalled();
    expect(e.enterFullscreen()).toBe("in");
    // Back in fullscreen with the picker over: leaving now counts.
    expect(e.exitFullscreen()).toBe("exited");
    expect(e.fullscreenExit).toHaveBeenCalledTimes(1);
  });

  it("downloading a supporting document or answer file: the save dialog / downloads panel", () => {
    const e = exam();
    e.expected.expect("download");
    e.advance(1_500); // the dialog opens once the download starts
    e.blur();
    e.advance(20_000);
    e.refocus();
    expect(e.focusLeft).not.toHaveBeenCalled();
  });

  it("the camera permission prompt, for as long as the browser's request is pending", () => {
    const e = exam();
    const done = e.expected.expect("permission-prompt");
    e.advance(20_000); // the learner reads the prompt
    e.blur(); // clicking Allow moves focus to the browser's prompt
    e.advance(BLUR_GRACE_MS * 3);
    e.refocus();
    done();
    expect(e.focusLeft).not.toHaveBeenCalled();
    e.blur();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
  });
});

describe("announcements stay narrow (focus monitoring isn't weakened)", () => {
  it("a file picker that never took focus stops covering after a few seconds", () => {
    const e = exam();
    e.expected.expect("file-picker");
    e.advance(EXPECTED_WINDOW_MS["file-picker"]! + 1);
    e.blur();
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
  });

  it("a download that opened no dialog stops covering after a few seconds", () => {
    const e = exam();
    e.expected.expect("download");
    e.advance(EXPECTED_WINDOW_MS.download! + 1);
    expect(e.exitFullscreen()).toBe("exited");
    expect(e.fullscreenExit).toHaveBeenCalledTimes(1);
  });

  it("one dialog excuses one departure: once the learner is back, leaving again counts", () => {
    const e = exam();
    e.expected.expect("file-picker");
    e.blur();
    e.advance(500);
    e.refocus(); // picker closed
    e.blur(); // straight to another app
    e.advance(BLUR_GRACE_MS);
    expect(e.focusLeft).toHaveBeenCalledTimes(1);
  });

  it("a finished permission prompt no longer covers anything", () => {
    const e = exam();
    const done = e.expected.expect("permission-prompt");
    done();
    expect(e.expected.pending()).toBe(0);
    expect(e.expected.covers("blur")).toBe(false);
  });

  it("a page becoming hidden is never covered", () => {
    const expected = createExpectedInteractions(() => 0);
    expected.expect("download");
    expect(expected.covers("hidden")).toBe(false);
    expect(expected.covers("blur")).toBe(true);
    expect(expected.covers("fullscreen")).toBe(true);
  });
});
