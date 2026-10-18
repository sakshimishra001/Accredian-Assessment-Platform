import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, publishAssessment } from "@/server/services/assessments";
import { extendAttempt } from "@/server/services/attempt-extension";
import { terminateAttempt } from "@/server/services/attempt-termination";
import {
  getMyAttemptClock,
  getMyExamOverview,
  LOCKED_MESSAGE,
  PROCTORING_TERMINATION_REASON,
  recordFocusViolation,
  recordProctoringEvent,
  saveResponses,
  startOrResumeAttempt,
  submitAttempt,
  type ExamQuestion,
} from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase } from "./helpers";

/*
 * Proctoring V1 step 2 — fullscreen enforcement, server side: what the exam is told, and how a
 * FULLSCREEN_EXIT report is recorded and enforced through the step-1 event path (one counter, one
 * limit and action with focus monitoring). The browser half is covered in tests/unit/fullscreen.test.ts.
 */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
let n = 0;
const incident = () => `fs-${++n}-${crypto.randomUUID().slice(0, 8)}`;
const exit = (id = incident()) => ({ eventType: "FULLSCREEN_EXIT", incidentId: id });
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
  async function login(i = 0) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, T);
    if (!r.ok) throw new Error(r.reason);
    return (await validateSessionToken(r.token, T))!;
  }
  async function start(i = 0) {
    const user = await login(i);
    const view = await startOrResumeAttempt(user, T);
    return { user, attemptId: view.attempt.id, view, mcq: view.sections.flatMap((s) => s.items as ExamQuestion[])[0] };
  }
  return { admin, assessment, T, login, start };
}

const FULLSCREEN = { proctoringEnabled: true, fullscreenEnabled: true };

// ===========================================================================
describe("when fullscreen is required", () => {
  it("1/2: fullscreen off, or proctoring off → no requirement and exits are not recorded", async () => {
    for (const settings of [{ proctoringEnabled: true, fullscreenEnabled: false }, { proctoringEnabled: false, fullscreenEnabled: true }]) {
      await resetDatabase();
      const s = await scenario(settings);
      expect((await getMyExamOverview(await s.login(), s.T)).assessment.fullscreen).toBeNull();
      const l = await s.start();
      expect(l.view.assessment.fullscreen).toBeNull();
      expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
      expect(await events(l.attemptId)).toHaveLength(0);
    }
  });

  it("3: proctoring + fullscreen on → the pre-exam screen and the exam are told, with the violation policy", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const overview = await getMyExamOverview(await s.login(), s.T);
    expect(overview.assessment.fullscreen).toEqual({ maxViolations: 3, action: "TERMINATE" });
    expect(overview.canStart).toBe(true);
    const l = await s.start();
    expect(l.view.assessment.fullscreen).toEqual({ maxViolations: 3, action: "TERMINATE" });
    expect(l.view.assessment.focusMonitoring).toBeNull();
  });
});

// ===========================================================================
describe("recording exits", () => {
  it("6/7/8: one exit → one FULLSCREEN_EXIT event; a repeated report of it adds nothing; below the limit the exam goes on", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    const id = incident();
    const when = at(s.T, 2);
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(id), when)).toMatchObject({ recorded: true, outcome: "WARNING", violations: 1, maxViolations: 3 });
    for (let i = 0; i < 3; i++) expect(await recordProctoringEvent(l.user, l.attemptId, exit(id), at(s.T, 3))).toMatchObject({ recorded: false, violations: 1 });
    const ev = await events(l.attemptId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: "FULLSCREEN_EXIT", severity: "MEDIUM", violationNumber: 1, actionTaken: null, metadata: null });
    expect(ev[0].timestamp.toISOString()).toBe(when.toISOString());
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", focusViolations: 1, lockedAt: null });
    expect(await db.auditLog.count({ where: { action: AuditAction.PROCTORING_VIOLATION, entityId: l.attemptId } })).toBe(1);
  });

  it("9: TERMINATE at the limit uses the existing termination; the learner is told it was proctoring, not an administrator", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    for (let i = 1; i <= 2; i++) expect((await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, i))).outcome).toBe("WARNING");
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 3))).toMatchObject({ recorded: true, outcome: "TERMINATED", violations: 3 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: PROCTORING_TERMINATION_REASON });
    expect((await events(l.attemptId)).map((e) => [e.violationNumber, e.actionTaken, e.severity])).toEqual([
      [1, null, "MEDIUM"],
      [2, null, "MEDIUM"],
      [3, "TERMINATE", "HIGH"],
    ]);
    expect(await getMyAttemptClock(l.user, l.attemptId, at(s.T, 4))).toMatchObject({ status: "TERMINATED", terminatedByFocus: true });
    expect((await getMyExamOverview(l.user, at(s.T, 4))).attempts.at(-1)).toMatchObject({ status: "TERMINATED", terminatedByFocus: true });
    // 13: a terminated attempt takes no more exits, and entering fullscreen can't restart it.
    await expect(recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 5))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(3);
  });

  it("10: LOCK at the limit uses the existing lock", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 2, focusViolationAction: "LOCK" });
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 2))).toMatchObject({ outcome: "LOCKED", violations: 2 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", lockedAt: at(s.T, 2) });
    await expect(saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.mcq.assessmentQuestionId, selectedOptionIds: [l.mcq.options[0].id] }] }, at(s.T, 3))).rejects.toThrow(LOCKED_MESSAGE);
    // Already locked: nothing more is counted.
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 4))).toMatchObject({ recorded: false, outcome: "LOCKED" });
    expect(await events(l.attemptId)).toHaveLength(2);
  });

  it("11: WARN records warnings at and past the limit without locking or terminating", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 2, focusViolationAction: "WARN" });
    const l = await s.start();
    for (let i = 1; i <= 4; i++) await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, i));
    expect((await events(l.attemptId)).map((e) => e.actionTaken)).toEqual([null, "WARNING", "WARNING", "WARNING"]);
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", lockedAt: null, focusViolations: 4 });
  });

  it("12: a submitted attempt takes no exits", async () => {
    const s = await scenario(FULLSCREEN);
    const l = await s.start();
    await submitAttempt(l.user, l.attemptId, {}, at(s.T, 5));
    await expect(recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 6))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("13: an attempt terminated by the administrator takes no exits", async () => {
    const s = await scenario(FULLSCREEN);
    const l = await s.start();
    await terminateAttempt(s.admin, { assessmentId: s.assessment.id, attemptId: l.attemptId, reason: "Policy breach" }, at(s.T, 2));
    await expect(recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 3))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("14/15: exits during a pause aren't recorded; the count survives pause and resume", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 3 });
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 1));
    await pauseAssessment(s.admin, s.assessment.id, at(s.T, 2));
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 3))).toMatchObject({ recorded: false, outcome: "IGNORED", violations: 1 });
    await resumeAssessment(s.admin, s.assessment.id, at(s.T, 10));
    expect((await attemptRow(l.attemptId)).focusViolations).toBe(1);
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 11))).toMatchObject({ recorded: true, violations: 2 });
    expect((await events(l.attemptId)).map((e) => e.violationNumber)).toEqual([1, 2]);
  });

  it("16: focus monitoring keeps working and shares the counter; one departure seen by both counts once", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMonitoringEnabled: true, focusMaxViolations: 5 });
    const l = await s.start();
    expect(l.view.assessment.focusMonitoring).toEqual({ maxViolations: 5, action: "TERMINATE" });
    // Alt+Tab: the window loses focus and fullscreen ends — the browser reports both with one incident.
    const departure = incident();
    expect(await recordFocusViolation(l.user, l.attemptId, departure, at(s.T, 1))).toMatchObject({ recorded: true, violations: 1 });
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(departure), at(s.T, 1))).toMatchObject({ recorded: false, violations: 1 });
    // A separate Esc: a new incident.
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 2))).toMatchObject({ recorded: true, violations: 2 });
    expect((await events(l.attemptId)).map((e) => [e.eventType, e.violationNumber])).toEqual([
      ["FOCUS_LOST", 1],
      ["FULLSCREEN_EXIT", 2],
    ]);
  });

  it("17: time extensions keep working alongside fullscreen enforcement", async () => {
    const s = await scenario(FULLSCREEN);
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 1));
    const before = (await getMyAttemptClock(l.user, l.attemptId, at(s.T, 2))).remainingSeconds;
    await extendAttempt(s.admin, { assessmentId: s.assessment.id, attemptId: l.attemptId, minutes: 15, reason: "Technical issue" }, at(s.T, 2));
    expect((await getMyAttemptClock(l.user, l.attemptId, at(s.T, 2))).remainingSeconds).toBe(before + 15 * 60);
    expect(await recordProctoringEvent(l.user, l.attemptId, exit(), at(s.T, 3))).toMatchObject({ recorded: true, violations: 2 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ extensionSeconds: 900, focusViolations: 2 });
  });
});

// ===========================================================================
describe("security", () => {
  it("18: the browser can't set the violation number, action, severity, time or status", async () => {
    const s = await scenario({ ...FULLSCREEN, focusMaxViolations: 3 });
    const l = await s.start();
    for (const forged of [{ violationNumber: 3 }, { actionTaken: "TERMINATE" }, { severity: "LOW" }, { timestamp: new Date(0).toISOString() }, { status: "SUBMITTED" }]) {
      await expect(recordProctoringEvent(l.user, l.attemptId, { ...exit(), ...forged }, at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", focusViolations: 0 });
    expect(await events(l.attemptId)).toHaveLength(0);
  });

  it("19: exits can't be recorded for another learner's attempt, or by staff", async () => {
    const s = await scenario(FULLSCREEN);
    const a = await s.start(0);
    const b = await s.start(1);
    await expect(recordProctoringEvent(b.user, a.attemptId, exit(), at(s.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordProctoringEvent(s.admin, a.attemptId, exit(), at(s.T, 1))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await events(a.attemptId)).toHaveLength(0);
  });
});
