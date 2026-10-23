import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { forAssessment, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessmentForBatch } from "@/server/services/assessments";
import { lockAttempt } from "@/server/services/attempt-lock";
import { terminateAttempt } from "@/server/services/attempt-termination";
import { getMyAttemptClock, saveResponses, startOrResumeAttempt, type ExamQuestion } from "@/server/services/attempts";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assignProctor } from "@/server/services/proctor-assignments";
import { assessmentInput, createActor, createBatchWithLearners, createCourse, createReadyPaper, hoursFromNow, resetDatabase } from "./helpers";

/* Proctor dashboard, phase 3: manual lock and terminate, end to end against PostgreSQL. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const REASON = "Another person answering the questions";

async function world() {
  const admin = await createActor(Role.ADMIN);
  const proctor = await createActor(Role.REVIEWER);
  const otherProctor = await createActor(Role.REVIEWER);
  const examiner = await createActor(Role.EXAMINER);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id);
  const startAt = hoursFromNow(1);
  const T = at(startAt, 5);
  async function exam() {
    const batch = await createBatchWithLearners(course.id, 1);
    const a = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION" }));
    await publishAssessmentForBatch(admin, a.id);
    const [c] = await issueExamCredentials(admin, a.id);
    const r = await authenticateExamCredential(c.learner.email, c.code, {}, T);
    const learner = (await validateSessionToken(r.ok ? r.token : null, T))!;
    const view = await startOrResumeAttempt(forAssessment(learner, a.id), T);
    return { a, learner, attemptId: view.attempt.id, q: view.sections.flatMap((s) => s.items as ExamQuestion[])[0] };
  }
  const A = await exam();
  const B = await exam();
  await assignProctor(admin, A.a.id, proctor.id);
  return { admin, proctor, otherProctor, examiner, A, B, T };
}

describe("manual lock", () => {
  it("an assigned proctor locks a running attempt; the learner's own clock poll sees it and saving is refused", async () => {
    const w = await world();
    await lockAttempt(w.proctor, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1));
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: w.A.attemptId } })).lockedAt).toEqual(at(w.T, 1));
    expect(await getMyAttemptClock(w.A.learner, w.A.attemptId, at(w.T, 2))).toMatchObject({ status: "IN_PROGRESS", locked: true, lockedBy: "proctor" });
    await expect(saveResponses(w.A.learner, w.A.attemptId, { responses: [{ assessmentQuestionId: w.A.q.assessmentQuestionId, selectedOptionIds: [] }] }, at(w.T, 2))).rejects.toThrow(/locked/);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.ATTEMPT_LOCKED, entityId: w.A.attemptId } });
    expect(audit).toMatchObject({ actorId: w.proctor.id, metadata: expect.objectContaining({ reason: REASON, trigger: "manual", assessmentId: w.A.a.id }) });
    await expect(lockAttempt(w.admin, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 3))).rejects.toBeInstanceOf(ConflictError);
  });

  it("unassigned proctor, examiner, cross-assessment attempt: refused, nothing changes", async () => {
    const w = await world();
    await expect(lockAttempt(w.otherProctor, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(lockAttempt(w.examiner, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(lockAttempt(w.proctor, { assessmentId: w.A.a.id, attemptId: w.B.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(lockAttempt(w.proctor, { assessmentId: w.B.a.id, attemptId: w.B.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.assessmentAttempt.count({ where: { lockedAt: { not: null } } })).toBe(0);
  });
});

describe("manual terminate", () => {
  it("an assigned proctor terminates; the learner's clock poll sees it (as a staff termination)", async () => {
    const w = await world();
    await terminateAttempt(w.proctor, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1));
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: w.A.attemptId } })).toMatchObject({ status: "TERMINATED", terminatedById: w.proctor.id, terminationReason: REASON });
    expect(await getMyAttemptClock(w.A.learner, w.A.attemptId, at(w.T, 2))).toMatchObject({ status: "TERMINATED", terminatedByFocus: false, terminatedBy: "proctor" });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.ATTEMPT_TERMINATED, entityId: w.A.attemptId } });
    expect(audit).toMatchObject({ actorId: w.proctor.id, metadata: expect.objectContaining({ reason: REASON, actorRole: "REVIEWER" }) });
  });

  it("unassigned proctor, examiner, cross-assessment attempt: refused, nothing changes", async () => {
    const w = await world();
    await expect(terminateAttempt(w.otherProctor, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(terminateAttempt(w.examiner, { assessmentId: w.A.a.id, attemptId: w.A.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(terminateAttempt(w.proctor, { assessmentId: w.A.a.id, attemptId: w.B.attemptId, reason: REASON }, at(w.T, 1))).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.assessmentAttempt.count({ where: { status: "TERMINATED" } })).toBe(0);
  });
});
