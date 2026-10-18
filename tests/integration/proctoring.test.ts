import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment } from "@/server/services/assessment-pause";
import { createAssessment, getAssessment, publishAssessment, updateAssessment } from "@/server/services/assessments";
import { FOCUS_TERMINATION_REASON, getMyExamOverview, PROCTORING_TERMINATION_REASON, recordFocusViolation, recordProctoringEvent, startOrResumeAttempt, submitAttempt, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { listAttemptProctoringEvents } from "@/server/services/proctoring";
import { assessmentInput, createActor, createReadyPaper, createAssessmentRow, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase } from "./helpers";

/*
 * Proctoring V1 step 1: configuration, the append-only event log and enforcement — built on the C3
 * focus-monitoring counter, limit, lock and termination (one mechanism, not two).
 */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
let n = 0;
const incident = () => `incident-${++n}-${crypto.randomUUID().slice(0, 8)}`;
const events = (attemptId: string) => db.proctoringEvent.findMany({ where: { attemptId }, orderBy: [{ violationNumber: "asc" }, { createdAt: "asc" }] });
const attemptRow = (id: string) => db.assessmentAttempt.findUniqueOrThrow({ where: { id } });

async function scenario(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections: [{ questions: [mcqSingle({ text: "Pick one" })] }] });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION", ...settings }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
  const T = at(startAt, 5);
  async function start(i = 0) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, T);
    if (!r.ok) throw new Error(r.reason);
    const user = (await validateSessionToken(r.token, T))!;
    const view = await startOrResumeAttempt(user, T);
    return { user, attemptId: view.attempt.id, view, mcq: view.sections.flatMap((s) => s.items as ExamQuestion[])[0] };
  }
  return { admin, assessment, T, start };
}

const BROWSER = { proctoringEnabled: true, focusMonitoringEnabled: true };

// ===========================================================================
describe("configuration", () => {
  it("1: existing and new assessments default to proctoring off, camera off", async () => {
    const admin = await createActor(Role.ADMIN);
    const legacy = await createAssessmentRow({ createdById: admin.id });
    expect(await db.assessment.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
      proctoringEnabled: false,
      fullscreenEnabled: false,
      clipboardMonitoringEnabled: false,
      cameraRequired: false,
      faceDetectionEnabled: false,
      multipleFaceDetectionEnabled: false,
      faceMissingDetectionEnabled: false,
      focusMaxViolations: 3,
      focusViolationAction: "TERMINATE",
    });
    const { assessment } = await scenario();
    const a = await getAssessment(admin, assessment.id);
    expect(a.proctoringEnabled).toBe(false);
    expect(a.settings).toMatchObject({ focusMonitoringEnabled: false, cameraRequired: false, faceDetectionEnabled: false });
  });

  it("2/3/4: an admin enables browser-only proctoring; it persists, the camera stays off, and turning proctoring off keeps the choices", async () => {
    const { admin, assessment } = await scenario();
    await updateAssessment(admin, assessment.id, { proctoringEnabled: true, focusMonitoringEnabled: true, fullscreenEnabled: true, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    let a = await getAssessment(admin, assessment.id);
    expect(a.proctoringEnabled).toBe(true);
    expect(a.settings).toMatchObject({ focusMonitoringEnabled: true, fullscreenEnabled: true, clipboardMonitoringEnabled: false, cameraRequired: false, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    await updateAssessment(admin, assessment.id, { proctoringEnabled: false });
    a = await getAssessment(admin, assessment.id);
    expect(a.proctoringEnabled).toBe(false);
    expect(a.settings).toMatchObject({ focusMonitoringEnabled: true, fullscreenEnabled: true });
  });

  it("5: camera detections are saved as chosen but never require the camera or record camera events", async () => {
    const s = await scenario({ proctoringEnabled: true, faceDetectionEnabled: true, multipleFaceDetectionEnabled: true, faceMissingDetectionEnabled: true });
    expect((await getAssessment(s.admin, s.assessment.id)).settings).toMatchObject({ cameraRequired: false, faceDetectionEnabled: true });
    const l = await s.start();
    // The camera isn't required, so the learner is never asked for it; no face settings reach the exam.
    expect(l.view.assessment.camera).toBeNull();
    expect((await getMyExamOverview(l.user, s.T)).assessment.camera).toBeNull();
    expect(JSON.stringify(l.view.assessment)).not.toMatch(/face/i);
    for (const eventType of ["FACE_NOT_DETECTED", "MULTIPLE_FACES", "CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED"]) {
      expect(await recordProctoringEvent(l.user, l.attemptId, { eventType, incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    }
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("6/7: maxViolations must be positive; the action must be WARN, LOCK or TERMINATE", async () => {
    const { admin, assessment } = await scenario();
    await expect(updateAssessment(admin, assessment.id, { focusMaxViolations: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAssessment(admin, assessment.id, { focusMaxViolations: -2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAssessment(admin, assessment.id, { focusViolationAction: "BAN" })).rejects.toBeInstanceOf(ValidationError);
    await updateAssessment(admin, assessment.id, { focusViolationAction: "WARN" });
    expect((await getAssessment(admin, assessment.id)).settings.focusViolationAction).toBe("WARN");
  });
});

// ===========================================================================
describe("recording events", () => {
  it("8/11/12/13: the learner's running attempt records events; time, number, severity and action are the server's", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 5 });
    const l = await s.start();
    const when = at(s.T, 2);
    const r = await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident(), durationMs: 4200, metadata: { visibility: "hidden" } }, when);
    expect(r).toMatchObject({ recorded: true, outcome: "WARNING", violations: 1, maxViolations: 5 });
    const [e] = await events(l.attemptId);
    expect(e).toMatchObject({ id: r.eventId, attemptId: l.attemptId, eventType: "FOCUS_LOST", severity: "MEDIUM", violationNumber: 1, actionTaken: null, durationMs: 4200, metadata: { visibility: "hidden" } });
    expect(e.timestamp.toISOString()).toBe(when.toISOString());
    // The browser can't choose the number, the time or the action.
    for (const forged of [{ violationNumber: 999 }, { timestamp: "2020-01-01T00:00:00Z" }, { actionTaken: "TERMINATE" }]) {
      await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident(), ...forged }, at(s.T, 3))).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 4))).violations).toBe(2);
    expect((await events(l.attemptId)).map((x) => x.violationNumber)).toEqual([1, 2]);
  });

  it("system events are recorded (low severity) without counting as violations", async () => {
    const s = await scenario(BROWSER);
    const l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "PROCTORING_STARTED" }, at(s.T, 1))).toMatchObject({ recorded: true, outcome: "RECORDED", violations: 0 });
    expect(await events(l.attemptId)).toMatchObject([{ eventType: "PROCTORING_STARTED", severity: "LOW", violationNumber: null, actionTaken: null }]);
    expect((await attemptRow(l.attemptId)).focusViolations).toBe(0);
  });

  it("controls that are off record nothing; with proctoring off nothing at all", async () => {
    const off = await scenario({ focusMonitoringEnabled: true });
    const l = await off.start();
    for (const eventType of ["FOCUS_LOST", "PROCTORING_STARTED", "FULLSCREEN_EXIT"]) {
      expect(await recordProctoringEvent(l.user, l.attemptId, { eventType, incidentId: incident() }, at(off.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    }
    expect(l.view.assessment.focusMonitoring).toBeNull();
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("9/10: nobody can record for someone else's attempt; staff can't record at all", async () => {
    const s = await scenario(BROWSER);
    const a = await s.start(0);
    const b = await s.start(1);
    await expect(recordProctoringEvent(b.user, a.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordProctoringEvent(b.user, "made-up", { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    for (const role of [Role.ADMIN, Role.EXAMINER, Role.REVIEWER]) {
      await expect(recordProctoringEvent(await createActor(role), a.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 1))).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await events(a.attemptId)).toHaveLength(0);
  });

  it("14: concurrent violations get distinct, consecutive numbers and the count stays exact", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 20, focusViolationAction: "WARN" });
    const l = await s.start();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 1 + i / 10))));
    expect(results.map((r) => r.violations).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await events(l.attemptId)).map((e) => e.violationNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await attemptRow(l.attemptId)).focusViolations).toBe(6);
  });

  it("15: events are append-only — no update or delete exists, and a repeated incident never rewrites one", async () => {
    const s = await scenario(BROWSER);
    const l = await s.start();
    const id = incident();
    await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: id, durationMs: 100 }, at(s.T, 1));
    const before = await events(l.attemptId);
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: id, durationMs: 999999 }, at(s.T, 2))).toMatchObject({ recorded: false, violations: 1 });
    expect(await events(l.attemptId)).toEqual(before);
    const service = await import("@/server/services/proctoring");
    const actions = await import("@/server/actions/attempts");
    expect(Object.keys(service)).toEqual(["listAttemptProctoringEvents"]);
    expect(Object.keys(actions).filter((k) => /proctor/i.test(k))).toEqual(["recordProctoringEventAction"]);
  });

  it("other browser controls share the one counter, limit and action", async () => {
    const s = await scenario({ ...BROWSER, fullscreenEnabled: true, clipboardMonitoringEnabled: true, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 1));
    await recordProctoringEvent(l.user, l.attemptId, { eventType: "FULLSCREEN_EXIT", incidentId: incident() }, at(s.T, 2));
    const r = await recordProctoringEvent(l.user, l.attemptId, { eventType: "CLIPBOARD_PASTE", incidentId: incident() }, at(s.T, 3));
    expect(r).toMatchObject({ outcome: "TERMINATED", violations: 3 });
    expect((await events(l.attemptId)).map((e) => [e.eventType, e.violationNumber, e.actionTaken])).toEqual([
      ["FOCUS_LOST", 1, null],
      ["FULLSCREEN_EXIT", 2, null],
      ["CLIPBOARD_PASTE", 3, "TERMINATE"],
    ]);
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: PROCTORING_TERMINATION_REASON });
    expect(await db.auditLog.count({ where: { action: AuditAction.PROCTORING_VIOLATION, entityId: l.attemptId } })).toBe(2);
  });

  it("camera events are recorded once the camera is required (infrastructure only — nothing detects them yet)", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, faceDetectionEnabled: true, faceMissingDetectionEnabled: true, focusMaxViolations: 5 });
    const l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: true, violations: 1 });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "MULTIPLE_FACES", incidentId: incident() }, at(s.T, 2))).toMatchObject({ recorded: false, outcome: "IGNORED" });
  });
});

// ===========================================================================
describe("camera (step 4)", () => {
  it("camera required with proctoring on: the learner is told before starting and the exam requires it", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, focusMaxViolations: 4, focusViolationAction: "LOCK" });
    const l = await s.start();
    expect(l.view.assessment.camera).toEqual({ maxViolations: 4, action: "LOCK", faceDetection: null });
    expect((await getMyExamOverview(l.user, s.T)).assessment.camera).toEqual({ maxViolations: 4, action: "LOCK", faceDetection: null });
    // Browser-only controls stay as configured (off): the camera doesn't turn anything else on.
    expect(l.view.assessment).toMatchObject({ focusMonitoring: null, fullscreen: null, clipboardMonitoring: null });
  });

  it("proctoring off or camera not required: no camera is asked for and camera events are ignored", async () => {
    for (const settings of [{ proctoringEnabled: false, cameraRequired: true }, { proctoringEnabled: true, cameraRequired: false, focusMonitoringEnabled: true }]) {
      const s = await scenario(settings);
      const l = await s.start();
      expect(l.view.assessment.camera).toBeNull();
      expect((await getMyExamOverview(l.user, s.T)).assessment.camera).toBeNull();
      for (const eventType of ["CAMERA_DISABLED", "CAMERA_PERMISSION_REVOKED"]) {
        expect(await recordProctoringEvent(l.user, l.attemptId, { eventType, incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
      }
      expect(await events(l.attemptId)).toHaveLength(0);
      await resetDatabase();
    }
  });

  it("camera loss and revocation are violations on the shared counter, enforced at the limit", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, focusMonitoringEnabled: true, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_DISABLED", incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: true, outcome: "WARNING", violations: 1 });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 2))).toMatchObject({ recorded: true, violations: 2 });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_PERMISSION_REVOKED", incidentId: incident() }, at(s.T, 3))).toMatchObject({ recorded: true, outcome: "TERMINATED", violations: 3 });
    expect((await events(l.attemptId)).map((e) => [e.eventType, e.violationNumber, e.severity, e.actionTaken])).toEqual([
      ["CAMERA_DISABLED", 1, "MEDIUM", null],
      ["FOCUS_LOST", 2, "MEDIUM", null],
      ["CAMERA_PERMISSION_REVOKED", 3, "HIGH", "TERMINATE"],
    ]);
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: PROCTORING_TERMINATION_REASON, focusViolations: 3 });
    expect((await getMyExamOverview(l.user, at(s.T, 4))).attempts.at(-1)).toMatchObject({ status: "TERMINATED", terminatedByFocus: true });
  });

  it("LOCK: a camera loss at the limit locks the attempt", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, focusMaxViolations: 1, focusViolationAction: "LOCK" });
    const l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_DISABLED", incidentId: incident() }, at(s.T, 1))).toMatchObject({ outcome: "LOCKED", violations: 1 });
    expect((await attemptRow(l.attemptId)).lockedAt).toEqual(at(s.T, 1));
  });

  it("one departure counts once: a camera loss and the fullscreen exit to fix it share an incident", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, fullscreenEnabled: true, focusMaxViolations: 5 });
    const l = await s.start();
    const id = incident();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_PERMISSION_REVOKED", incidentId: id }, at(s.T, 1))).toMatchObject({ recorded: true, violations: 1 });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FULLSCREEN_EXIT", incidentId: id }, at(s.T, 2))).toMatchObject({ recorded: false, violations: 1 });
    expect(await events(l.attemptId)).toHaveLength(1);
  });

  it("camera events carry no media: only small plain values are accepted", async () => {
    const s = await scenario({ proctoringEnabled: true, cameraRequired: true, focusMaxViolations: 5 });
    const l = await s.start();
    const frame = `data:image/jpeg;base64,${"A".repeat(5000)}`;
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_DISABLED", incidentId: incident(), metadata: { frame } }, at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_DISABLED", incidentId: incident(), video: frame }, at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    expect(await events(l.attemptId)).toHaveLength(0);
  });
});

// ===========================================================================
describe("face detection (step 5)", () => {
  const FACE = { proctoringEnabled: true, cameraRequired: true, faceDetectionEnabled: true, faceMissingDetectionEnabled: true, multipleFaceDetectionEnabled: true };

  it("face settings reach the learner's exam (instructions and exam) only when in force", async () => {
    const s = await scenario({ ...FACE, focusMaxViolations: 5, focusViolationAction: "WARN" });
    const l = await s.start();
    const expected = { maxViolations: 5, action: "WARN", faceDetection: { missing: true, multiple: true } };
    expect(l.view.assessment.camera).toEqual(expected);
    expect((await getMyExamOverview(l.user, s.T)).assessment.camera).toEqual(expected);
  });

  it("each face event has its own switch; off is reflected in the exam data", async () => {
    const s = await scenario({ ...FACE, multipleFaceDetectionEnabled: false });
    const l = await s.start();
    expect(l.view.assessment.camera?.faceDetection).toEqual({ missing: true, multiple: false });
  });

  it("face settings without the camera (or with face detection or proctoring off) send nothing face-related", async () => {
    for (const settings of [{ ...FACE, cameraRequired: false }, { ...FACE, faceDetectionEnabled: false }, { ...FACE, proctoringEnabled: false }]) {
      const s = await scenario(settings);
      const l = await s.start();
      expect(l.view.assessment.camera?.faceDetection ?? null).toBeNull();
      expect((await getMyExamOverview(l.user, s.T)).assessment.camera?.faceDetection ?? null).toBeNull();
      await resetDatabase();
    }
  });

  it("FACE_NOT_DETECTED is ignored when face detection (or face-missing) is off; MULTIPLE_FACES when its own switch is off", async () => {
    let s = await scenario({ ...FACE, faceDetectionEnabled: false });
    let l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    await resetDatabase();
    s = await scenario({ ...FACE, faceMissingDetectionEnabled: false });
    l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "MULTIPLE_FACES", incidentId: incident() }, at(s.T, 2))).toMatchObject({ recorded: true });
    await resetDatabase();
    s = await scenario({ ...FACE, multipleFaceDetectionEnabled: false });
    l = await s.start();
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "MULTIPLE_FACES", incidentId: incident() }, at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 2))).toMatchObject({ recorded: true });
  });

  it("face events count toward WARN (recorded, the learner carries on)", async () => {
    const s = await scenario({ ...FACE, focusMaxViolations: 2, focusViolationAction: "WARN" });
    const l = await s.start();
    const types = ["FACE_NOT_DETECTED", "MULTIPLE_FACES", "FACE_NOT_DETECTED"] as const;
    for (const [i, eventType] of types.entries()) {
      const faces = eventType === "MULTIPLE_FACES" ? 2 : 0;
      expect(await recordProctoringEvent(l.user, l.attemptId, { eventType, incidentId: incident(), durationMs: 10_000, metadata: { faces } }, at(s.T, i + 1))).toMatchObject({ recorded: true, violations: i + 1 });
    }
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", lockedAt: null, focusViolations: 3 });
    expect((await events(l.attemptId)).map((e) => [e.eventType, e.metadata])).toEqual([
      ["FACE_NOT_DETECTED", { faces: 0 }],
      ["MULTIPLE_FACES", { faces: 2 }],
      ["FACE_NOT_DETECTED", { faces: 0 }],
    ]);
  });

  it("face events count toward LOCK", async () => {
    const s = await scenario({ ...FACE, focusMaxViolations: 2, focusViolationAction: "LOCK" });
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, { eventType: "MULTIPLE_FACES", incidentId: incident() }, at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 2))).toMatchObject({ outcome: "LOCKED", violations: 2 });
    expect((await attemptRow(l.attemptId)).lockedAt).toEqual(at(s.T, 2));
  });

  it("face events count toward TERMINATE, on the same counter as focus and camera", async () => {
    const s = await scenario({ ...FACE, focusMonitoringEnabled: true, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 1));
    await recordProctoringEvent(l.user, l.attemptId, { eventType: "CAMERA_DISABLED", incidentId: incident() }, at(s.T, 2));
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident() }, at(s.T, 3))).toMatchObject({ outcome: "TERMINATED", violations: 3 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: PROCTORING_TERMINATION_REASON });
  });

  it("one departure counts once: focus loss, fullscreen exit and a missing face sharing an incident", async () => {
    const s = await scenario({ ...FACE, focusMonitoringEnabled: true, fullscreenEnabled: true, focusMaxViolations: 5 });
    const l = await s.start();
    const id = incident();
    expect(await recordFocusViolation(l.user, l.attemptId, id, at(s.T, 1))).toMatchObject({ recorded: true, violations: 1 });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FULLSCREEN_EXIT", incidentId: id }, at(s.T, 1))).toMatchObject({ recorded: false, violations: 1 });
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: id }, at(s.T, 2))).toMatchObject({ recorded: false, violations: 1 });
    expect(await events(l.attemptId)).toHaveLength(1);
  });

  it("only small event details are accepted — never image data", async () => {
    const s = await scenario(FACE);
    const l = await s.start();
    const image = `data:image/png;base64,${"A".repeat(4000)}`;
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "FACE_NOT_DETECTED", incidentId: incident(), metadata: { frame: image } }, at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "MULTIPLE_FACES", incidentId: incident(), metadata: { boxes: [1, 2] } }, at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    expect(await events(l.attemptId)).toHaveLength(0);
  });
});

// ===========================================================================
describe("enforcement", () => {
  it("16/17: C3 focus monitoring works as before and is recorded as proctoring events; termination at the limit", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 2, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    expect(l.view.assessment.focusMonitoring).toEqual({ maxViolations: 2, action: "TERMINATE" });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 1))).toEqual({ recorded: true, outcome: "WARNING", violations: 1, maxViolations: 2 });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 2))).toEqual({ recorded: true, outcome: "TERMINATED", violations: 2, maxViolations: 2 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: FOCUS_TERMINATION_REASON, focusViolations: 2 });
    const ev = await events(l.attemptId);
    expect(ev.map((e) => [e.eventType, e.violationNumber, e.actionTaken, e.severity])).toEqual([
      ["FOCUS_LOST", 1, null, "MEDIUM"],
      ["FOCUS_LOST", 2, "TERMINATE", "HIGH"],
    ]);
    const audits = await db.auditLog.findMany({ where: { entityId: l.attemptId, action: { in: [AuditAction.ATTEMPT_FOCUS_VIOLATION, AuditAction.ATTEMPT_TERMINATED] } }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual([AuditAction.ATTEMPT_FOCUS_VIOLATION, AuditAction.ATTEMPT_FOCUS_VIOLATION, AuditAction.ATTEMPT_TERMINATED]);
    expect(audits[2].metadata).toMatchObject({ trigger: "focus_monitoring", eventId: ev[1].id });
    // 20: a terminated attempt takes no more events.
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 3))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(2);
  });

  it("18: LOCK uses the existing lock; a locked attempt counts nothing more", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 1, focusViolationAction: "LOCK" });
    const l = await s.start();
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 1))).toMatchObject({ outcome: "LOCKED", violations: 1 });
    expect((await attemptRow(l.attemptId)).lockedAt).toEqual(at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 2))).toMatchObject({ recorded: false, outcome: "LOCKED" });
    expect((await events(l.attemptId)).map((e) => e.actionTaken)).toEqual(["LOCK"]);
    expect(await db.auditLog.count({ where: { action: AuditAction.ATTEMPT_LOCKED, entityId: l.attemptId } })).toBe(1);
  });

  it("WARN records a warning at and after the limit; the learner carries on", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 2, focusViolationAction: "WARN" });
    const l = await s.start();
    for (let i = 1; i <= 3; i++) await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, i));
    expect((await events(l.attemptId)).map((e) => e.actionTaken)).toEqual([null, "WARNING", "WARNING"]);
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", lockedAt: null, focusViolations: 3 });
    expect(l.view.assessment.focusMonitoring).toEqual({ maxViolations: 2, action: "WARN" });
  });

  it("19: a submitted attempt takes no new violations", async () => {
    const s = await scenario(BROWSER);
    const l = await s.start();
    await submitAttempt(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.mcq.assessmentQuestionId, selectedOptionIds: [l.mcq.options[0].id] }] }, at(s.T, 5));
    await expect(recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 6))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("21: while the assessment is paused, violations are ignored — no event, no count, no enforcement", async () => {
    const s = await scenario({ ...BROWSER, focusMaxViolations: 1 });
    const l = await s.start();
    await pauseAssessment(s.admin, s.assessment.id, at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, { eventType: "FOCUS_LOST", incidentId: incident() }, at(s.T, 2))).toMatchObject({ recorded: false, outcome: "IGNORED" });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", focusViolations: 0, lockedAt: null });
    expect(await events(l.attemptId)).toHaveLength(0);
  });
});

// ===========================================================================
describe("reading events", () => {
  it("22/23/24: learners see only their own; examiners only their assigned candidates' attempts; admins any; proctors none", async () => {
    const s = await scenario(BROWSER);
    const a = await s.start(0);
    const b = await s.start(1);
    await recordFocusViolation(a.user, a.attemptId, incident(), at(s.T, 1));

    expect(await listAttemptProctoringEvents(a.user, a.attemptId)).toHaveLength(1);
    await expect(listAttemptProctoringEvents(b.user, a.attemptId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAttemptProctoringEvents(s.admin, a.attemptId)).toMatchObject([{ eventType: "FOCUS_LOST", violationNumber: 1 }]);
    await expect(listAttemptProctoringEvents(s.admin, "made-up")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAttemptProctoringEvents(await createActor(Role.REVIEWER), a.attemptId)).rejects.toBeInstanceOf(ForbiddenError);

    const [assigned, other] = [await createActor(Role.EXAMINER), await createActor(Role.EXAMINER)];
    const candidates = await listCandidates(s.admin, s.assessment.id);
    await assignExaminer(s.admin, s.assessment.id, [candidates.find((c) => c.learner.id === a.user.id)!.id], assigned.id);
    await submitAttempt(a.user, a.attemptId, { responses: [{ assessmentQuestionId: a.mcq.assessmentQuestionId, selectedOptionIds: [a.mcq.options[0].id] }] }, at(s.T, 5));
    expect(await listAttemptProctoringEvents(assigned, a.attemptId)).toHaveLength(1);
    await expect(listAttemptProctoringEvents(other, a.attemptId)).rejects.toBeInstanceOf(NotFoundError);
    void b;
  });
});
