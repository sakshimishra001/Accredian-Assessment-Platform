import { describe, expect, it } from "vitest";
import { MONITORING_EVENT_TYPES } from "@/lib/proctoring/monitoring-events";
import { dismissNotification, mergeNotifications } from "@/lib/proctoring/notifications";
import {
  createSeen,
  learnerViolationAlert,
  learnerViolationNotice,
  MAX_PROCTOR_ALERTS,
  notificationChime,
  parseSoundPreference,
  proctorViolationAlert,
  proctorViolationDecision,
  upsertAlert,
  type ProctorViolationNotice,
} from "@/lib/proctoring/sound-alerts";

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

describe("louder, more visible alerts (UX update)", () => {
  const result = (violations: number, outcome = "WARNING") => ({ recorded: true, outcome, violations, maxViolations: 3 });

  it("a counted violation gives the learner one notice for both the sound and the on-screen PROCTORING ALERT", () => {
    const seen = createSeen();
    expect(learnerViolationNotice("FOCUS_LOST", result(2), seen)).toEqual({ key: "violation:2", what: "Tab or window switch detected", violation: 2, max: 3, outcome: "WARNING" });
    expect(learnerViolationNotice("FULLSCREEN_EXIT", result(3, "LOCKED"), seen)).toMatchObject({ what: "Fullscreen exit detected", violation: 3, max: 3 });
    expect(learnerViolationNotice("CLIPBOARD_PASTE", result(4), seen)).toMatchObject({ what: "Paste detected" });
    // The same violation (stream retry / re-render): no second sound or alert.
    expect(learnerViolationNotice("FOCUS_LOST", result(2), seen)).toBeNull();
  });

  it("uncounted camera / face / screen events never raise the learner's violation alert", () => {
    const seen = createSeen();
    for (const t of ["CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED", "FACE_NOT_DETECTED", "MULTIPLE_FACES", "SCREEN_SHARE_STOPPED", "SCREEN_SHARE_PERMISSION_DENIED", "CAMERA_CONNECTED", "SCREEN_SHARE_STARTED"] as const) {
      expect(learnerViolationNotice(t, { recorded: true, outcome: "RECORDED", violations: 0, maxViolations: 3 }, seen)).toBeNull();
    }
  });

  it("the proctor: a new live violation → visual alert, plus sound when switched on; sound Off keeps the visual alert", () => {
    const e = { type: "PROCTORING_VIOLATION" as const, attemptId: "att-1", at: "2026-11-05T10:42:18.000Z", eventId: "ev-1" };
    expect(proctorViolationDecision(e, true, createSeen())).toEqual({ visual: true, sound: true });
    expect(proctorViolationDecision(e, false, createSeen())).toEqual({ visual: true, sound: false });
  });

  it("the proctor: a replayed event (same id) raises nothing; other monitoring events never alert", () => {
    const seen = createSeen();
    const e = { type: "PROCTORING_VIOLATION" as const, attemptId: "att-1", at: "2026-11-05T10:42:18.000Z", eventId: "ev-1" };
    expect(proctorViolationDecision(e, true, seen)).toEqual({ visual: true, sound: true });
    expect(proctorViolationDecision({ ...e }, true, seen)).toEqual({ visual: false, sound: false });
    expect(proctorViolationDecision({ ...e, eventId: "ev-2" }, true, seen)).toEqual({ visual: true, sound: true });
    for (const type of MONITORING_EVENT_TYPES.filter((t) => t !== "PROCTORING_VIOLATION")) {
      expect(proctorViolationDecision({ type, attemptId: "att-1", at: e.at, eventId: "ev-9" }, true, seen)).toEqual({ visual: false, sound: false });
    }
  });

  it("proctor alerts stack newest first, update in place when details arrive, and are capped", () => {
    const base = (key: string): ProctorViolationNotice => ({ key, attemptId: "att", at: "2026-11-05T10:00:00.000Z", learnerName: null, what: "Proctoring violation", violation: null, max: null });
    let list = upsertAlert([], base("a"));
    list = upsertAlert(list, base("b"));
    expect(list.map((x) => x.key)).toEqual(["b", "a"]);
    list = upsertAlert(list, { ...base("a"), learnerName: "Sakshi Mishra", what: "Tab or window switch detected", violation: 2, max: 3 });
    expect(list.map((x) => [x.key, x.learnerName])).toEqual([["b", null], ["a", "Sakshi Mishra"]]);
    for (const k of ["c", "d", "e", "f"]) list = upsertAlert(list, base(k));
    expect(list).toHaveLength(MAX_PROCTOR_ALERTS);
    expect(list[0].key).toBe("f");
  });

  it("a learner notification stays until acknowledged — polls don't remove it — and only then goes", () => {
    const n = { id: "n1", message: "Please restore screen sharing.", sentAt: "2026-11-05T10:00:00.000Z" };
    let shown = mergeNotifications([], [n]);
    for (let poll = 0; poll < 5; poll++) shown = mergeNotifications(shown, poll % 2 ? [n] : []);
    expect(shown.map((x) => x.id)).toEqual(["n1"]);
    shown = dismissNotification(shown, "n1");
    expect(shown).toEqual([]);
  });

  it("several unread notifications each stay listed and individually acknowledgeable; one chime for the batch", () => {
    const seen = createSeen();
    notificationChime([], seen, false); // the page's initial load (nothing yet)
    const list = mergeNotifications([], [
      { id: "a", message: "One", sentAt: "2026-11-05T10:00:00.000Z" },
      { id: "b", message: "Two", sentAt: "2026-11-05T10:00:05.000Z" },
    ]);
    expect(notificationChime(["a", "b"], seen, true)).toBe(true);
    expect(notificationChime(["a", "b"], seen, true)).toBe(false);
    expect(dismissNotification(list, "a").map((x) => x.id)).toEqual(["b"]);
  });
});
