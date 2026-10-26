import { describe, expect, it, vi } from "vitest";
import { createClipboardMonitor } from "@/lib/proctoring/clipboard-monitor";
import { CLIPBOARD_EVENTS, effectiveProctoring, eventEnabled, PROCTORING_EVENT_LABEL, type ProctoringSettings } from "@/lib/proctoring/config";
import { proctoringEventSchema } from "@/lib/validation/proctoring";

/* Proctoring V1 step 3 — clipboard monitoring in the browser and its rules (server side: integration tests). */

/** A browser event that fails the test if anything reads it (e.g. clipboardData) or cancels it. */
function untouchableEvent() {
  return new Proxy({}, {
    get: (_t, prop) => {
      throw new Error(`clipboard event was read: ${String(prop)}`);
    },
  });
}

describe("browser monitor", () => {
  it("3/4/5/17: copy, cut and paste are each reported as their own event", () => {
    const report = vi.fn();
    const m = createClipboardMonitor({ isIdle: () => false, report });
    m.handle("copy", untouchableEvent());
    m.handle("paste", untouchableEvent());
    m.handle("cut", untouchableEvent());
    expect(report.mock.calls.map((c) => c[0])).toEqual(["CLIPBOARD_COPY", "CLIPBOARD_PASTE", "CLIPBOARD_CUT"]);
  });

  it("6/7: one operation is reported once even if its event reaches the handler twice; contents are never read", () => {
    const report = vi.fn();
    const m = createClipboardMonitor({ isIdle: () => false, report });
    const e = untouchableEvent();
    expect([m.handle("paste", e), m.handle("paste", e)]).toEqual([true, false]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("13/16: nothing is reported while paused, locked or closing", () => {
    let idle = true;
    const report = vi.fn();
    const m = createClipboardMonitor({ isIdle: () => idle, report });
    m.handle("copy", untouchableEvent());
    expect(report).not.toHaveBeenCalled();
    idle = false;
    m.handle("copy", untouchableEvent());
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("configuration", () => {
  const base: ProctoringSettings = {
    proctoringEnabled: true,
    focusMonitoringEnabled: true,
    fullscreenEnabled: true,
    clipboardMonitoringEnabled: false,
    cameraRequired: false,
    faceDetectionEnabled: false,
    multipleFaceDetectionEnabled: false,
    faceMissingDetectionEnabled: false, cameraSnapshotsEnabled: false, screenMonitoringEnabled: false,
  };

  it("1/2: clipboard events count only with proctoring on and clipboard monitoring explicitly on", () => {
    for (const t of CLIPBOARD_EVENTS) {
      expect(eventEnabled(t, effectiveProctoring(base)), t).toBe(false); // proctoring on is not enough
      expect(eventEnabled(t, effectiveProctoring({ ...base, proctoringEnabled: false, clipboardMonitoringEnabled: true })), t).toBe(false);
      expect(eventEnabled(t, effectiveProctoring({ ...base, clipboardMonitoringEnabled: true })), t).toBe(true);
    }
  });

  it("4: cut is its own event type, never a copy", () => {
    expect(CLIPBOARD_EVENTS).toEqual(["CLIPBOARD_COPY", "CLIPBOARD_CUT", "CLIPBOARD_PASTE"]);
    expect(PROCTORING_EVENT_LABEL.CLIPBOARD_CUT).toBe("Clipboard cut");
    expect(proctoringEventSchema.safeParse({ eventType: "CLIPBOARD_CUT", incidentId: "incident-0001" }).success).toBe(true);
  });

  it("8: the browser can't send a violation number, action or the clipboard text", () => {
    for (const extra of [{ violationNumber: 1 }, { actionTaken: "WARNING" }, { text: "copied words" }, { clipboardData: "x" }]) {
      expect(proctoringEventSchema.safeParse({ eventType: "CLIPBOARD_PASTE", incidentId: "incident-0001", ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});
