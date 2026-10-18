import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDepartureTracker, createFullscreenMonitor, startAfterFullscreen } from "@/lib/proctoring/fullscreen-monitor";
import { enterFullscreen, FullscreenGate, FullscreenRequirement, leaveFullscreen } from "@/app/learner/(portal)/assessment/[id]/fullscreen";

/* Proctoring V1 step 2 — fullscreen enforcement in the browser (the server side is in the integration tests). */

afterEach(() => vi.unstubAllGlobals());

function harness(start: { fullscreen: boolean; idle?: boolean }) {
  const state = { fullscreen: start.fullscreen, idle: start.idle ?? false };
  const onExit = vi.fn();
  const monitor = createFullscreenMonitor({ isFullscreen: () => state.fullscreen, isIdle: () => state.idle, onExit });
  return { state, onExit, monitor };
}

describe("exit detection", () => {
  it("6/7: one physical exit is reported once, however many events the browser fires", () => {
    const { state, onExit, monitor } = harness({ fullscreen: true });
    state.fullscreen = false;
    expect([monitor.sync(), monitor.sync(), monitor.sync()]).toEqual(["exited", "out", "out"]);
    expect(onExit).toHaveBeenCalledTimes(1);
    // Back in fullscreen, then out again: a second exit.
    state.fullscreen = true;
    expect(monitor.sync()).toBe("in");
    state.fullscreen = false;
    expect(monitor.sync()).toBe("exited");
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("14/15: an exit while paused (or locked / closing) is never reported — not even after the resume", () => {
    const { state, onExit, monitor } = harness({ fullscreen: true });
    state.idle = true;
    state.fullscreen = false;
    expect(monitor.sync()).toBe("out");
    state.idle = false;
    expect(monitor.sync()).toBe("out"); // asked to return, no violation
    expect(onExit).not.toHaveBeenCalled();
    state.fullscreen = true;
    monitor.sync();
    state.fullscreen = false;
    expect(monitor.sync()).toBe("exited");
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("a page loaded outside fullscreen (reload, resume) is asked to return, without a violation", () => {
    const { onExit, monitor } = harness({ fullscreen: false });
    expect([monitor.sync(), monitor.sync()]).toEqual(["out", "out"]);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("16: focus loss and a fullscreen exit from the same departure share one incident", () => {
    let n = 0;
    const d = createDepartureTracker(() => `incident-${++n}`);
    expect(d.leave("focus")).toBe("incident-1");
    expect(d.leave("fullscreen")).toBe("incident-1");
    d.back("focus");
    expect(d.leave("focus")).toBe("incident-1"); // still out of fullscreen: same departure
    d.back("focus");
    d.back("fullscreen");
    expect(d.leave("fullscreen")).toBe("incident-2");
  });
});

describe("starting the exam", () => {
  it("1/3/4/5: the exam starts only when fullscreen isn't required or was actually entered", async () => {
    const start = vi.fn(async () => "attempt");
    expect(await startAfterFullscreen(null, start)).toEqual({ started: true, result: "attempt" });
    expect(await startAfterFullscreen(Promise.resolve("ok"), start)).toEqual({ started: true, result: "attempt" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(await startAfterFullscreen(Promise.resolve("denied"), start)).toEqual({ started: false, reason: "denied" });
    expect(await startAfterFullscreen(Promise.resolve("unsupported"), start)).toEqual({ started: false, reason: "unsupported" });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("4: the Fullscreen API wrapper never assumes success", async () => {
    vi.stubGlobal("document", { fullscreenEnabled: false, documentElement: {}, fullscreenElement: null });
    expect(await enterFullscreen()).toBe("unsupported");

    const refusing = { fullscreenEnabled: true, fullscreenElement: null, documentElement: { requestFullscreen: vi.fn(() => Promise.reject(new TypeError("Permissions check failed"))) } };
    vi.stubGlobal("document", refusing);
    expect(await enterFullscreen()).toBe("denied");

    const doc: { fullscreenEnabled: boolean; fullscreenElement: object | null; documentElement: object; exitFullscreen: () => Promise<void> } = {
      fullscreenEnabled: true,
      fullscreenElement: null,
      documentElement: {},
      exitFullscreen: vi.fn(async () => void (doc.fullscreenElement = null)),
    };
    doc.documentElement = { requestFullscreen: vi.fn(async () => void (doc.fullscreenElement = doc.documentElement)) };
    vi.stubGlobal("document", doc);
    expect(await enterFullscreen()).toBe("ok");
    leaveFullscreen();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe("screens", () => {
  const gate = (p: Partial<Parameters<typeof FullscreenGate>[0]> = {}) =>
    renderToStaticMarkup(createElement(FullscreenGate, { exited: true, supported: true, violations: 1, maxViolations: 3, action: "TERMINATE", error: null, onReturn: () => {}, ...p }));

  it("after an exit: a warning, the count, what happens next, and a way back", () => {
    const html = gate();
    expect(html).toContain("Fullscreen mode exited");
    expect(html).toContain("Please return to fullscreen to continue your assessment.");
    expect(html).toContain("Violation 1 of 3");
    expect(html).toContain("2 more violations and your exam will be terminated.");
    expect(html).toContain("Return to Fullscreen");
    expect(gate({ action: "LOCK", violations: 2 })).toContain("One more violation and your exam will be locked.");
    expect(gate({ action: "WARN", violations: 5 })).toContain("Each exit is recorded for the administrator.");
    expect(gate({ exited: false, violations: 0 })).toContain("Fullscreen mode required");
  });

  it("11: unsupported browsers are told to use a desktop browser, and get no button", () => {
    const html = gate({ supported: false });
    expect(html).toContain("supported desktop browser");
    expect(html).not.toContain("Return to Fullscreen");
  });

  it("3: the pre-exam requirement explains the rules", () => {
    const html = renderToStaticMarkup(createElement(FullscreenRequirement, { action: "TERMINATE", maxViolations: 3 }));
    expect(html).toContain("Fullscreen mode is required for this assessment");
    expect(html).toContain("Leaving fullscreen is recorded as a proctoring violation.");
    expect(html).toContain("at the limit your exam is terminated");
  });
});
