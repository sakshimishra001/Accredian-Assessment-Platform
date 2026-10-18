import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, getAssessment, publishAssessment } from "@/server/services/assessments";
import { extendAttempt } from "@/server/services/attempt-extension";
import { terminateAttempt } from "@/server/services/attempt-termination";
import {
  FOCUS_TERMINATION_REASON,
  getMyAttempt,
  getMyAttemptClock,
  getMyExamOverview,
  LOCKED_MESSAGE,
  recordFocusViolation,
  saveResponses,
  startOrResumeAttempt,
  submitAttempt,
  TERMINATED_MESSAGE,
  type ExamQuestion,
} from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { uploadAnswerFile } from "@/server/services/files";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/* Focus monitoring, against assessment_test: the server keeps the count and enforces the limit. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
let n = 0;
const incident = () => `incident-${++n}-${crypto.randomUUID().slice(0, 8)}`;
const CSV = Buffer.from("a,b\n1,2\n");

async function scenario(focus: { enabled?: boolean; max?: number; action?: "LOCK" | "TERMINATE" } = {}, learners = 1) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        questions: [
          mcqSingle({ text: "Pick one" }),
          { ...shortAnswer({ text: "Explain and attach." }), response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false } },
        ],
      },
    ],
  });
  const batch = await createBatchWithLearners(course.id, learners);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, {
      type: "MIXED",
      paperId: paper.id,
      batchId: batch.id,
      startAt,
      endAt: at(startAt, 180),
      durationMinutes: 60,
      timingMode: "FULL_DURATION",
      // Focus monitoring runs under the proctoring master switch (on wherever focus monitoring is, as the migration sets it).
      proctoringEnabled: focus.enabled ?? true,
      focusMonitoringEnabled: focus.enabled ?? true,
      focusMaxViolations: focus.max ?? 3,
      focusViolationAction: focus.action ?? "TERMINATE",
    }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
  const T = at(startAt, 5);
  async function start(i = 0) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, T);
    if (!r.ok) throw new Error(r.reason);
    const user = (await validateSessionToken(r.token, T))!;
    const view = await startOrResumeAttempt(user, T);
    const [mcq, written] = view.sections.flatMap((s) => s.items as ExamQuestion[]);
    await saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Saved before" }] }, at(T, 1));
    return { user, attemptId: view.attempt.id, view, mcq, written };
  }
  return { admin, assessment, T, start };
}

const focusAudit = (attemptId: string) => db.auditLog.findMany({ where: { action: "attempt.focus_violation", entityId: attemptId }, orderBy: { createdAt: "asc" } });

// ===========================================================================
describe("configuration", () => {
  it("defaults to off, limit 3, terminate; settings persist", async () => {
    const off = await scenario({ enabled: false });
    expect((await getAssessment(off.admin, off.assessment.id)).settings).toMatchObject({ focusMonitoringEnabled: false, focusMaxViolations: 3, focusViolationAction: "TERMINATE" });
    const on = await scenario({ max: 5, action: "LOCK" });
    expect((await getAssessment(on.admin, on.assessment.id)).settings).toMatchObject({ focusMonitoringEnabled: true, focusMaxViolations: 5, focusViolationAction: "LOCK" });
    const l = await on.start();
    expect(l.view.assessment.focusMonitoring).toEqual({ maxViolations: 5, action: "LOCK" });
    expect(l.view.attempt).toMatchObject({ locked: false, focusViolations: 0 });
  });
});

describe("recording violations", () => {
  it("1: monitoring off — nothing is recorded", async () => {
    const { T, start } = await scenario({ enabled: false });
    const l = await start();
    expect(l.view.assessment.focusMonitoring).toBeNull();
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 2))).toMatchObject({ recorded: false, outcome: "IGNORED", violations: 0 });
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).focusViolations).toBe(0);
    expect(await focusAudit(l.attemptId)).toHaveLength(0);
  });

  it("2/3/4: each departure counts once with a warning; below the limit the learner carries on; audited", async () => {
    const { T, start } = await scenario({ max: 3 });
    const l = await start();
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 2))).toEqual({ recorded: true, outcome: "WARNING", violations: 1, maxViolations: 3 });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 3))).toMatchObject({ recorded: true, outcome: "WARNING", violations: 2 });
    // Below the limit: answering, the timer and the attempt carry on.
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.written.assessmentQuestionId, textAnswer: "Still going" }] }, at(T, 4));
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 4))).toMatchObject({ status: "IN_PROGRESS", locked: false, remainingSeconds: (60 - 4) * 60 });
    expect((await getMyAttempt(l.user, l.attemptId, at(T, 4))).attempt.focusViolations).toBe(2);
    const audit = await focusAudit(l.attemptId);
    expect(audit.map((a) => (a.metadata as { violation: number; actionTaken: string }).violation)).toEqual([1, 2]);
    expect(audit[0]).toMatchObject({ actorId: l.user.id });
    expect(audit[0].metadata).toMatchObject({ assessmentId: l.view.assessment.id, learnerId: l.user.id, maxViolations: 3, actionTaken: "WARNING" });
  });

  it("5: at the limit with TERMINATE the attempt is terminated (system reason); answers kept; nothing more can be done", async () => {
    const { T, start } = await scenario({ max: 2, action: "TERMINATE" });
    const l = await start();
    await uploadAnswerFile(l.user, l.attemptId, l.written.assessmentQuestionId, { name: "w.csv", data: CSV }, {}, at(T, 1));
    await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 2));
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 3))).toMatchObject({ recorded: true, outcome: "TERMINATED", violations: 2 });
    const row = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } });
    expect(row).toMatchObject({ status: "TERMINATED", terminationReason: FOCUS_TERMINATION_REASON, terminatedById: null, terminatedAt: at(T, 3), submittedAt: null });
    expect(await db.attemptResponse.count({ where: { attemptId: l.attemptId } })).toBe(1);
    expect(await db.answerAttachment.count({ where: { response: { attemptId: l.attemptId } } })).toBe(1);
    await expect(saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.written.assessmentQuestionId, textAnswer: "x" }] }, at(T, 4))).rejects.toThrow(TERMINATED_MESSAGE);
    await expect(submitAttempt(l.user, l.attemptId, {}, at(T, 4))).rejects.toThrow(TERMINATED_MESSAGE);
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 4))).toMatchObject({ status: "TERMINATED", terminatedByFocus: true });
    const overview = await getMyExamOverview(l.user, at(T, 4));
    expect(overview.attempts[0]).toMatchObject({ status: "TERMINATED", terminatedByFocus: true });
    expect(JSON.stringify(overview)).not.toContain(FOCUS_TERMINATION_REASON);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "attempt.terminated", entityId: l.attemptId } })).toMatchObject({ actorId: null });
    expect((await focusAudit(l.attemptId)).at(-1)?.metadata).toMatchObject({ violation: 2, actionTaken: "TERMINATE" });
  });

  it("6: at the limit with LOCK the attempt is locked (still in progress): no answering, uploading or submitting; it closes at its deadline with the saved answers", async () => {
    const { T, start } = await scenario({ max: 2, action: "LOCK" });
    const l = await start();
    await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 2));
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 3))).toMatchObject({ recorded: true, outcome: "LOCKED", violations: 2 });
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId }, select: { status: true, lockedAt: true } })).toEqual({ status: "IN_PROGRESS", lockedAt: at(T, 3) });
    await expect(saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.written.assessmentQuestionId, textAnswer: "x" }] }, at(T, 4))).rejects.toThrow(LOCKED_MESSAGE);
    await expect(uploadAnswerFile(l.user, l.attemptId, l.written.assessmentQuestionId, { name: "w.csv", data: CSV }, {}, at(T, 4))).rejects.toThrow(LOCKED_MESSAGE);
    await expect(submitAttempt(l.user, l.attemptId, {}, at(T, 4))).rejects.toThrow(LOCKED_MESSAGE);
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 4))).toMatchObject({ status: "IN_PROGRESS", locked: true });
    expect((await getMyAttempt(l.user, l.attemptId, at(T, 4))).attempt.locked).toBe(true);
    // Further departures change nothing; reloading resumes the same locked attempt (no new attempt).
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 5))).toMatchObject({ recorded: false, outcome: "LOCKED", violations: 2 });
    expect((await startOrResumeAttempt(l.user, at(T, 6))).attempt).toMatchObject({ id: l.attemptId, locked: true });
    expect(await db.assessmentAttempt.count({ where: { learnerId: l.user.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "attempt.locked", entityId: l.attemptId } })).toBe(1);
    // At its deadline the attempt closes with what was saved before the lock.
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 61))).toMatchObject({ status: "AUTO_SUBMITTED" });
    expect((await db.attemptResponse.findFirstOrThrow({ where: { attemptId: l.attemptId } })).textAnswer).toBe("Saved before");
  });

  it("7: the same incident counts once; rapid concurrent reports never overshoot the limit", async () => {
    const { T, start } = await scenario({ max: 3, action: "TERMINATE" });
    const l = await start();
    const same = incident();
    expect(await recordFocusViolation(l.user, l.attemptId, same, at(T, 2))).toMatchObject({ recorded: true, violations: 1 });
    expect(await recordFocusViolation(l.user, l.attemptId, same, at(T, 2))).toMatchObject({ recorded: false, violations: 1 });
    const burst = await Promise.allSettled(Array.from({ length: 6 }, () => recordFocusViolation(l.user, l.attemptId, incident(), at(T, 3))));
    const row = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } });
    expect(row).toMatchObject({ focusViolations: 3, status: "TERMINATED" });
    expect(burst.filter((b) => b.status === "fulfilled" && b.value.recorded)).toHaveLength(2);
    expect(await focusAudit(l.attemptId)).toHaveLength(3);
  });

  it("8/9: submitted and terminated attempts can't record violations", async () => {
    const { admin, assessment, T, start } = await scenario({}, 2);
    const a = await start(0);
    await submitAttempt(a.user, a.attemptId, {}, at(T, 2));
    await expect(recordFocusViolation(a.user, a.attemptId, incident(), at(T, 3))).rejects.toThrow(/already been submitted/);
    const b = await start(1);
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, reason: "Duplicate attempt" }, at(T, 2));
    await expect(recordFocusViolation(b.user, b.attemptId, incident(), at(T, 3))).rejects.toThrow(TERMINATED_MESSAGE);
    expect(await db.assessmentAttempt.aggregate({ _sum: { focusViolations: true } })).toMatchObject({ _sum: { focusViolations: 0 } });
  });

  it("10/14: nothing is recorded while the assessment is paused; pause/resume timing is unchanged", async () => {
    const { admin, assessment, T, start } = await scenario();
    const l = await start();
    await pauseAssessment(admin, assessment.id, at(T, 10));
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 12))).toMatchObject({ recorded: false, outcome: "IGNORED", violations: 0 });
    await resumeAssessment(admin, assessment.id, at(T, 20));
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 20))).toMatchObject({ remainingSeconds: 50 * 60 });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 21))).toMatchObject({ recorded: true, violations: 1 });
  });

  it("11: the browser can't set the count — only an incident id is accepted, the server increments by one", async () => {
    const { T, start } = await scenario({ max: 3 });
    const l = await start();
    for (const bad of [999, "999", "", { violationCount: 999 }, "x".repeat(65), "drop table;"]) {
      await expect(recordFocusViolation(l.user, l.attemptId, bad, at(T, 2))).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await recordFocusViolation(l.user, l.attemptId, "violationCount-999", at(T, 2))).toMatchObject({ violations: 1 });
    // Only the learner's own attempt.
    const other = await scenario();
    const stranger = await other.start();
    await expect(recordFocusViolation(stranger.user, l.attemptId, incident(), at(T, 3))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("12/13: the timer and time extensions work as before alongside violations", async () => {
    const { admin, assessment, T, start } = await scenario({ max: 3 });
    const l = await start();
    await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 5));
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 10))).toMatchObject({ remainingSeconds: 50 * 60 });
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: l.attemptId, minutes: 15, reason: "Technical issue" }, at(T, 10));
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 10))).toMatchObject({ remainingSeconds: 65 * 60 });
    expect(await recordFocusViolation(l.user, l.attemptId, incident(), at(T, 11))).toMatchObject({ violations: 2 });
    expect(await getMyAttemptClock(l.user, l.attemptId, at(T, 20))).toMatchObject({ remainingSeconds: 55 * 60 });
  });
});
