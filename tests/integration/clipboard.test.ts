import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, publishAssessment } from "@/server/services/assessments";
import { terminateAttempt } from "@/server/services/attempt-termination";
import {
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
 * Proctoring V1 step 3 — clipboard monitoring, server side: copy / cut / paste reports go through the
 * step-1 event path (one counter, one limit and action), and nothing about the clipboard's contents
 * is ever accepted or stored. The browser half is in tests/unit/clipboard.test.ts.
 */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
let n = 0;
const incident = () => `cb-${++n}-${crypto.randomUUID().slice(0, 8)}`;
const op = (eventType: "CLIPBOARD_COPY" | "CLIPBOARD_CUT" | "CLIPBOARD_PASTE", extra: Record<string, unknown> = {}) => ({ eventType, incidentId: incident(), ...extra });
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

const CLIPBOARD = { proctoringEnabled: true, clipboardMonitoringEnabled: true };

// ===========================================================================
describe("when clipboard monitoring is on", () => {
  it("1/2: clipboard monitoring off, or proctoring off → nothing is monitored or recorded", async () => {
    for (const settings of [{ proctoringEnabled: true, clipboardMonitoringEnabled: false, focusMonitoringEnabled: true }, { proctoringEnabled: false, clipboardMonitoringEnabled: true }]) {
      await resetDatabase();
      const s = await scenario(settings);
      expect((await getMyExamOverview(await s.login(), s.T)).assessment.clipboardMonitoring).toBe(false);
      const l = await s.start();
      expect(l.view.assessment.clipboardMonitoring).toBeNull();
      for (const t of ["CLIPBOARD_COPY", "CLIPBOARD_CUT", "CLIPBOARD_PASTE"] as const) {
        expect(await recordProctoringEvent(l.user, l.attemptId, op(t), at(s.T, 1))).toMatchObject({ recorded: false, outcome: "IGNORED" });
      }
      expect(await events(l.attemptId)).toHaveLength(0);
    }
  });

  it("the learner is told before starting, and the exam is told to monitor", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 4, focusViolationAction: "WARN" });
    expect((await getMyExamOverview(await s.login(), s.T)).assessment.clipboardMonitoring).toBe(true);
    const l = await s.start();
    expect(l.view.assessment.clipboardMonitoring).toEqual({ maxViolations: 4, action: "WARN" });
    expect(l.view.assessment.fullscreen).toBeNull();
    expect(l.view.assessment.focusMonitoring).toBeNull();
  });
});

// ===========================================================================
describe("recording operations", () => {
  it("3/4/5/7/17: copy, cut and paste each create their own event; the server numbers them", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 10 });
    const l = await s.start();
    for (const [i, t] of (["CLIPBOARD_COPY", "CLIPBOARD_PASTE", "CLIPBOARD_CUT"] as const).entries()) {
      expect(await recordProctoringEvent(l.user, l.attemptId, op(t), at(s.T, i + 1))).toMatchObject({ recorded: true, outcome: "WARNING", violations: i + 1 });
    }
    const ev = await events(l.attemptId);
    expect(ev.map((e) => [e.eventType, e.violationNumber, e.severity, e.actionTaken, e.metadata, e.durationMs])).toEqual([
      ["CLIPBOARD_COPY", 1, "MEDIUM", null, null, null],
      ["CLIPBOARD_PASTE", 2, "MEDIUM", null, null, null],
      ["CLIPBOARD_CUT", 3, "MEDIUM", null, null, null],
    ]);
    expect(ev[0].timestamp.toISOString()).toBe(at(s.T, 1).toISOString());
    expect(await db.auditLog.count({ where: { action: AuditAction.PROCTORING_VIOLATION, entityId: l.attemptId } })).toBe(3);
  });

  it("the same report sent twice (a retry) is counted once", async () => {
    const s = await scenario(CLIPBOARD);
    const l = await s.start();
    const report = op("CLIPBOARD_PASTE");
    await recordProctoringEvent(l.user, l.attemptId, report, at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, report, at(s.T, 1))).toMatchObject({ recorded: false, violations: 1 });
    expect(await events(l.attemptId)).toHaveLength(1);
  });

  it("6/8/21: no clipboard contents (or anything else) can be sent — and none reach the database or the audit log", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 10 });
    const l = await s.start();
    const SECRET = "secret-answer-from-clipboard-42";
    for (const forged of [{ metadata: { text: SECRET } }, { metadata: { length: 31 } }, { durationMs: 5 }, { text: SECRET }, { clipboardData: SECRET }, { violationNumber: 1 }, { actionTaken: "WARNING" }]) {
      await expect(recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE", forged), at(s.T, 1))).rejects.toBeInstanceOf(ValidationError);
    }
    await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 2));
    const [{ hits }] = await db.$queryRaw<{ hits: bigint }[]>`
      SELECT (SELECT count(*) FROM "proctoring_events" WHERE "metadata"::text LIKE ${"%" + SECRET + "%"})
           + (SELECT count(*) FROM "audit_logs" WHERE "metadata"::text LIKE ${"%" + SECRET + "%"}) AS hits`;
    expect(Number(hits)).toBe(0);
    expect(await events(l.attemptId)).toMatchObject([{ eventType: "CLIPBOARD_PASTE", violationNumber: 1, metadata: null }]);
  });
});

// ===========================================================================
describe("enforcement", () => {
  it("9/12: copy, paste, cut with limit 3 and TERMINATE → the third terminates through the existing termination", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const l = await s.start();
    expect((await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_COPY"), at(s.T, 1))).outcome).toBe("WARNING");
    expect((await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 2))).outcome).toBe("WARNING");
    expect(await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_CUT"), at(s.T, 3))).toMatchObject({ outcome: "TERMINATED", violations: 3 });
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "TERMINATED", terminatedById: null, terminationReason: PROCTORING_TERMINATION_REASON });
    expect((await events(l.attemptId)).at(-1)).toMatchObject({ eventType: "CLIPBOARD_CUT", actionTaken: "TERMINATE", severity: "HIGH" });
    // 15: a terminated attempt takes no more.
    await expect(recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_COPY"), at(s.T, 4))).rejects.toBeInstanceOf(ConflictError);
    expect(await events(l.attemptId)).toHaveLength(3);
  });

  it("10: WARN records warnings and the learner carries on", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 3, focusViolationAction: "WARN" });
    const l = await s.start();
    for (let i = 1; i <= 4; i++) await recordProctoringEvent(l.user, l.attemptId, op(i % 2 ? "CLIPBOARD_COPY" : "CLIPBOARD_PASTE"), at(s.T, i));
    expect((await events(l.attemptId)).map((e) => e.actionTaken)).toEqual([null, null, "WARNING", "WARNING"]);
    expect(await attemptRow(l.attemptId)).toMatchObject({ status: "IN_PROGRESS", lockedAt: null });
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.mcq.assessmentQuestionId, selectedOptionIds: [l.mcq.options[0].id] }] }, at(s.T, 5));
  });

  it("11/16: LOCK locks the attempt; a locked attempt counts nothing more", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 2, focusViolationAction: "LOCK" });
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_COPY"), at(s.T, 1));
    expect(await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 2))).toMatchObject({ outcome: "LOCKED", violations: 2 });
    await expect(saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.mcq.assessmentQuestionId, selectedOptionIds: [l.mcq.options[0].id] }] }, at(s.T, 3))).rejects.toThrow(LOCKED_MESSAGE);
    expect(await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_CUT"), at(s.T, 4))).toMatchObject({ recorded: false, outcome: "LOCKED" });
    expect(await events(l.attemptId)).toHaveLength(2);
  });

  it("13: paused → not recorded; the count survives pause and resume", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMaxViolations: 5 });
    const l = await s.start();
    await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_COPY"), at(s.T, 1));
    await pauseAssessment(s.admin, s.assessment.id, at(s.T, 2));
    expect(await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 3))).toMatchObject({ recorded: false, outcome: "IGNORED", violations: 1 });
    await resumeAssessment(s.admin, s.assessment.id, at(s.T, 8));
    expect(await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 9))).toMatchObject({ recorded: true, violations: 2 });
  });

  it("14/15: submitted, or terminated by the administrator → no clipboard violations", async () => {
    const s = await scenario(CLIPBOARD);
    const a = await s.start(0);
    const b = await s.start(1);
    await submitAttempt(a.user, a.attemptId, {}, at(s.T, 2));
    await terminateAttempt(s.admin, { assessmentId: s.assessment.id, attemptId: b.attemptId, reason: "Policy breach" }, at(s.T, 2));
    await expect(recordProctoringEvent(a.user, a.attemptId, op("CLIPBOARD_COPY"), at(s.T, 3))).rejects.toBeInstanceOf(ConflictError);
    await expect(recordProctoringEvent(b.user, b.attemptId, op("CLIPBOARD_COPY"), at(s.T, 3))).rejects.toBeInstanceOf(ConflictError);
    expect(await db.proctoringEvent.count()).toBe(0);
  });

  it("18/19: focus monitoring and fullscreen keep working — each event stays separate, on one counter", async () => {
    const s = await scenario({ ...CLIPBOARD, focusMonitoringEnabled: true, fullscreenEnabled: true, focusMaxViolations: 10 });
    const l = await s.start();
    expect(l.view.assessment).toMatchObject({ focusMonitoring: { maxViolations: 10 }, fullscreen: { maxViolations: 10 }, clipboardMonitoring: { maxViolations: 10 } });
    // Switch to another app (focus lost), copy there is outside the browser; back in the exam, paste.
    await recordFocusViolation(l.user, l.attemptId, incident(), at(s.T, 1));
    await recordProctoringEvent(l.user, l.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 2));
    await recordProctoringEvent(l.user, l.attemptId, { eventType: "FULLSCREEN_EXIT", incidentId: incident() }, at(s.T, 3));
    expect((await events(l.attemptId)).map((e) => [e.eventType, e.violationNumber])).toEqual([
      ["FOCUS_LOST", 1],
      ["CLIPBOARD_PASTE", 2],
      ["FULLSCREEN_EXIT", 3],
    ]);
  });
});

// ===========================================================================
describe("security", () => {
  it("20: no clipboard events for another learner's attempt, or from staff", async () => {
    const s = await scenario(CLIPBOARD);
    const a = await s.start(0);
    const b = await s.start(1);
    await expect(recordProctoringEvent(b.user, a.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordProctoringEvent(s.admin, a.attemptId, op("CLIPBOARD_PASTE"), at(s.T, 1))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await events(a.attemptId)).toHaveLength(0);
  });
});
