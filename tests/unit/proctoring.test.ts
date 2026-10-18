import { describe, expect, it } from "vitest";
import { effectiveProctoring, eventEnabled, eventSeverity, isViolation, type ProctoringSettings } from "@/lib/proctoring/config";
import { proctoringSummary } from "@/lib/proctoring/summary";
import { assessmentFieldsSchema, updateAssessmentSchema } from "@/lib/validation/assessment";
import { proctoringEventSchema } from "@/lib/validation/proctoring";

/* Proctoring V1 step 1: configuration rules and the event input contract (no detection here). */

const OFF: ProctoringSettings = {
  proctoringEnabled: false,
  focusMonitoringEnabled: false,
  fullscreenEnabled: false,
  clipboardMonitoringEnabled: false,
  cameraRequired: false,
  faceDetectionEnabled: false,
  multipleFaceDetectionEnabled: false,
  faceMissingDetectionEnabled: false,
};
const ALL_ON: ProctoringSettings = Object.fromEntries(Object.keys(OFF).map((k) => [k, true])) as unknown as ProctoringSettings;

describe("configuration", () => {
  it("1: every control defaults to off; maxViolations 3, action TERMINATE", () => {
    const parsed = assessmentFieldsSchema.partial().parse({});
    for (const k of ["proctoringEnabled", "fullscreenEnabled", "clipboardMonitoringEnabled", "cameraRequired", "faceDetectionEnabled", "multipleFaceDetectionEnabled", "faceMissingDetectionEnabled"]) {
      expect(assessmentFieldsSchema.shape[k as keyof typeof assessmentFieldsSchema.shape].parse(undefined), k).toBe(false);
    }
    expect(parsed).toBeDefined();
    expect(assessmentFieldsSchema.shape.focusMaxViolations.parse(undefined)).toBe(3);
    expect(assessmentFieldsSchema.shape.focusViolationAction.parse(undefined)).toBe("TERMINATE");
  });

  it("the master switch gates everything: saved controls do nothing while proctoring is off", () => {
    expect(Object.values(effectiveProctoring({ ...ALL_ON, proctoringEnabled: false })).every((v) => v === false)).toBe(true);
    expect(proctoringSummary({ ...ALL_ON, proctoringEnabled: false, focusMaxViolations: 3, focusViolationAction: "TERMINATE" })).toBe("Off");
  });

  it("3/4: browser-only proctoring works with the camera off", () => {
    const p = effectiveProctoring({ ...OFF, proctoringEnabled: true, focusMonitoringEnabled: true, fullscreenEnabled: true });
    expect(p).toEqual({ enabled: true, focus: true, fullscreen: true, clipboard: false, camera: false, faceDetection: false, multipleFaces: false, faceMissing: false });
    expect(proctoringSummary({ ...OFF, proctoringEnabled: true, focusMonitoringEnabled: true, focusMaxViolations: 3, focusViolationAction: "TERMINATE" })).toBe("On · Focus monitoring · limit 3, then terminate the exam");
  });

  it("5: camera detections never turn the camera on — they apply only while the camera is required", () => {
    const detectionsOnly = effectiveProctoring({ ...OFF, proctoringEnabled: true, faceDetectionEnabled: true, multipleFaceDetectionEnabled: true, faceMissingDetectionEnabled: true });
    expect(detectionsOnly).toMatchObject({ camera: false, faceDetection: false, multipleFaces: false, faceMissing: false });
    for (const t of ["FACE_NOT_DETECTED", "MULTIPLE_FACES", "CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED"] as const) expect(eventEnabled(t, detectionsOnly)).toBe(false);
    // Multiple-face / face-missing checks are parts of face detection.
    expect(effectiveProctoring({ ...OFF, proctoringEnabled: true, cameraRequired: true, multipleFaceDetectionEnabled: true })).toMatchObject({ camera: true, faceDetection: false, multipleFaces: false });
    expect(effectiveProctoring(ALL_ON)).toMatchObject({ camera: true, faceDetection: true, multipleFaces: true, faceMissing: true });
  });

  it("6: maxViolations must be a positive whole number", () => {
    for (const bad of [0, -1, 1.5, "abc", 21]) expect(updateAssessmentSchema.safeParse({ focusMaxViolations: bad }).success, String(bad)).toBe(false);
    for (const ok of [1, 3, "5", 20]) expect(updateAssessmentSchema.safeParse({ focusMaxViolations: ok }).success, String(ok)).toBe(true);
  });

  it("7: the action is WARN, LOCK or TERMINATE only", () => {
    for (const ok of ["WARN", "LOCK", "TERMINATE"]) expect(updateAssessmentSchema.safeParse({ focusViolationAction: ok }).success).toBe(true);
    for (const bad of ["WARNING", "BAN", "", "terminate"]) expect(updateAssessmentSchema.safeParse({ focusViolationAction: bad }).success, bad).toBe(false);
  });

  it("a partial update never resets proctoring settings it doesn't mention", () => {
    expect(updateAssessmentSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });
});

describe("events", () => {
  it("event types map to their controls; system events aren't violations", () => {
    const p = effectiveProctoring(ALL_ON);
    expect(eventEnabled("FOCUS_LOST", p) && eventEnabled("CLIPBOARD_PASTE", p) && eventEnabled("PROCTORING_STARTED", p)).toBe(true);
    expect(eventEnabled("CLIPBOARD_COPY", effectiveProctoring({ ...OFF, proctoringEnabled: true, focusMonitoringEnabled: true }))).toBe(false);
    expect([isViolation("PROCTORING_STARTED"), isViolation("PROCTORING_STOPPED"), isViolation("FOCUS_LOST"), isViolation("MULTIPLE_FACES")]).toEqual([false, false, true, true]);
  });

  it("severity is fixed per type and HIGH when the event locked or terminated the attempt", () => {
    expect([eventSeverity("PROCTORING_STARTED", null), eventSeverity("FOCUS_LOST", null), eventSeverity("MULTIPLE_FACES", null)]).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect([eventSeverity("FOCUS_LOST", "WARNING"), eventSeverity("FOCUS_LOST", "LOCK"), eventSeverity("FOCUS_LOST", "TERMINATE")]).toEqual(["MEDIUM", "HIGH", "HIGH"]);
  });

  it("12/13: the browser can't send the time, violation number, severity or action", () => {
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", incidentId: "incident-0001" }).success).toBe(true);
    for (const extra of [{ violationNumber: 999 }, { timestamp: "2020-01-01T00:00:00Z" }, { severity: "LOW" }, { actionTaken: "WARNING" }, { attemptId: "other" }]) {
      expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("only known event types and small, plain metadata are accepted", () => {
    expect(proctoringEventSchema.safeParse({ eventType: "SCREEN_RECORDING" }).success).toBe(false);
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", durationMs: -1 }).success).toBe(false);
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", metadata: { visibility: "hidden", ms: 1200, blur: true } }).success).toBe(true);
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", metadata: { frame: { data: "…" } } }).success).toBe(false);
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", metadata: { image: "x".repeat(201) } }).success).toBe(false);
    expect(proctoringEventSchema.safeParse({ eventType: "FOCUS_LOST", metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])) }).success).toBe(false);
  });
});
