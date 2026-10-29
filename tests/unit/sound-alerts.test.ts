import { describe, expect, it } from "vitest";
import { MONITORING_EVENT_TYPES } from "@/lib/proctoring/monitoring-events";
import { createSeen, learnerViolationAlert, notificationChime, parseSoundPreference, proctorViolationAlert } from "@/lib/proctoring/sound-alerts";

/*
 * Audio alerts (phase 8 add-on): when a sound plays — the decisions only. No browser audio is
 * involved; playing itself is a no-op without Web Audio.
 */

const counted = (violations: number, outcome = "WARNING") => ({ recorded: true, outcome, violations });

describe("learner violation alert", () => {
  it("a counted violation (focus / tab, fullscreen, clipboard copy / cut / paste) → alert", () => {
    const seen = createSeen();
    expect(learnerViolationAlert("FOCUS_LOST", counted(1), seen)).toBe(true);
    expect(learnerViolationAlert("FULLSCREEN_EXIT", counted(2), seen)).toBe(true);
    expect(learnerViolationAlert("CLIPBOARD_COPY", counted(3), seen)).toBe(true);
    expect(learnerViolationAlert("CLIPBOARD_CUT", counted(4), seen)).toBe(true);
    expect(learnerViolationAlert("CLIPBOARD_PASTE", counted(5, "LOCKED"), seen)).toBe(true);
    expect(learnerViolationAlert("FOCUS_LOST", counted(6, "TERMINATED"), seen)).toBe(true);
  });

  it("non-counted proctoring events → no violation alert", () => {
    const seen = createSeen();
    for (const t of ["CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED", "FACE_NOT_DETECTED", "MULTIPLE_FACES", "SCREEN_SHARE_STOPPED", "SCREEN_SHARE_PERMISSION_DENIED", "CAMERA_CONNECTED", "SCREEN_SHARE_STARTED", "PROCTORING_STARTED"] as const) {
      expect(learnerViolationAlert(t, { recorded: true, outcome: "RECORDED", violations: 0 }, seen)).toBe(false);
      // Even if a response claimed otherwise, the event type alone rules it out.
      expect(learnerViolationAlert(t, counted(9), seen)).toBe(false);
    }
  });

  it("a violation that wasn't counted (repeated incident, ignored, locked) → no alert", () => {
    const seen = createSeen();
    expect(learnerViolationAlert("FOCUS_LOST", { recorded: false, outcome: "WARNING", violations: 1 }, seen)).toBe(false);
    expect(learnerViolationAlert("FOCUS_LOST", { recorded: false, outcome: "IGNORED", violations: 1 }, seen)).toBe(false);
    expect(learnerViolationAlert("FULLSCREEN_EXIT", { recorded: false, outcome: "LOCKED", violations: 1 }, seen)).toBe(false);
  });

  it("the same violation never sounds twice (its number is unique per attempt)", () => {
    const seen = createSeen();
    expect(learnerViolationAlert("FOCUS_LOST", counted(1), seen)).toBe(true);
    expect(learnerViolationAlert("FOCUS_LOST", counted(1), seen)).toBe(false);
    expect(learnerViolationAlert("FOCUS_LOST", counted(2), seen)).toBe(true);
  });
});

describe("learner notification chime", () => {
  it("notifications already there when the page opens (or reopens after a refresh) → no chime", () => {
    const seen = createSeen();
    expect(notificationChime(["n1", "n2"], seen, false)).toBe(false); // the initial load
  });

  it("a newly received notification → one chime; polling / a reconnect returning it again → none", () => {
    const seen = createSeen();
    notificationChime(["n1"], seen, false); // initial load
    expect(notificationChime(["n1", "n2"], seen, true)).toBe(true); // n2 is new
    expect(notificationChime(["n1", "n2"], seen, true)).toBe(false); // the next poll
    expect(notificationChime(["n2"], seen, true)).toBe(false); // the stream announcing it again after a reconnect
    expect(notificationChime([], seen, true)).toBe(false);
    expect(notificationChime(["n3", "n4"], seen, true)).toBe(true); // several at once: one chime
  });
});

describe("proctor violation alert", () => {
  const violation = (attemptId: string, at: string) => ({ type: "PROCTORING_VIOLATION" as const, attemptId, at });

  it("sound enabled → alert for a new live PROCTORING_VIOLATION", () => {
    expect(proctorViolationAlert(violation("att-1", "2026-10-27T10:00:00.000Z"), true, createSeen())).toBe(true);
  });

  it("sound disabled → no alert", () => {
    expect(proctorViolationAlert(violation("att-1", "2026-10-27T10:00:00.000Z"), false, createSeen())).toBe(false);
  });

  it("the same event delivered twice → one alert; another learner's or a later violation → its own alert", () => {
    const seen = createSeen();
    const e = violation("att-1", "2026-10-27T10:00:00.000Z");
    expect(proctorViolationAlert(e, true, seen)).toBe(true);
    expect(proctorViolationAlert({ ...e }, true, seen)).toBe(false);
    expect(proctorViolationAlert(violation("att-2", "2026-10-27T10:00:00.000Z"), true, seen)).toBe(true);
    expect(proctorViolationAlert(violation("att-1", "2026-10-27T10:00:05.000Z"), true, seen)).toBe(true);
  });

  it("every other monitoring event → no alert (camera / face / screen status, evidence, presence, notifications…)", () => {
    const seen = createSeen();
    for (const type of MONITORING_EVENT_TYPES.filter((t) => t !== "PROCTORING_VIOLATION")) {
      expect(proctorViolationAlert({ type, attemptId: "att-1", at: "2026-10-27T10:00:00.000Z" }, true, seen)).toBe(false);
    }
  });

  it("the preference is off unless explicitly switched on", () => {
    expect([parseSoundPreference(null), parseSoundPreference("off"), parseSoundPreference("garbage"), parseSoundPreference("on")]).toEqual([false, false, false, true]);
  });
});

describe("de-duplication memory is bounded", () => {
  it("keeps only the most recent keys", () => {
    const seen = createSeen(3);
    for (const k of ["a", "b", "c", "d"]) seen.firstTime(k);
    expect([seen.has("a"), seen.has("b"), seen.has("d")]).toEqual([false, true, true]);
  });
});
