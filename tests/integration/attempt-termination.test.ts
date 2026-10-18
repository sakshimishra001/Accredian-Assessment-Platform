import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, publishAssessment } from "@/server/services/assessments";
import { terminateAllActiveAttempts, terminateAttempt } from "@/server/services/attempt-termination";
import { getMyAttemptClock, getMyExamOverview, saveResponses, startOrResumeAttempt, submitAttempt, TERMINATED_MESSAGE, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { uploadAnswerFile } from "@/server/services/files";
import { getMyResult, listAssessmentResults } from "@/server/services/results";
import { MemoryStorage, storage } from "@/server/storage";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/* Administrator termination of exam attempts, against assessment_test (explicit clocks throughout). */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const actions = await import("@/server/actions/assessments");

const store = storage() as MemoryStorage;
beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const MIN = 60_000;
const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * MIN);
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const CSV = Buffer.from("region,sales\nNorth,120\n");
const REASON = "Violation of exam rules — phone in use";

/** A live (FULL_DURATION) assessment of `learners` learners: one MCQ and one written question that takes a CSV file. */
async function scenario(learners = 2) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        questions: [
          mcqSingle({ text: "Pick one" }),
          { ...shortAnswer({ text: "Analyse the data." }), response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false } },
        ],
      },
    ],
  });
  const batch = await createBatchWithLearners(course.id, learners);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { name: "Data Analytics Final", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION" }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
  const T = at(startAt, 5);

  async function learner(i: number, now = T) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, now);
    if (!r.ok) throw new Error(`exam login failed: ${r.reason}`);
    return { user: (await validateSessionToken(r.token, now))!, token: r.token, candidateId: issued[i].candidateId };
  }
  /** Sign in, start, save an MCQ answer and a written answer, and upload a file. */
  async function startWithAnswers(i: number) {
    const l = await learner(i);
    const view = await startOrResumeAttempt(l.user, T);
    const [mcq, written] = view.sections.flatMap((s) => s.items as ExamQuestion[]);
    await saveResponses(l.user, view.attempt.id, { responses: [{ assessmentQuestionId: mcq.assessmentQuestionId, selectedOptionIds: [mcq.options[0].id] }, { assessmentQuestionId: written.assessmentQuestionId, textAnswer: "My analysis" }] }, at(T, 1));
    const upload = await uploadAnswerFile(l.user, view.attempt.id, written.assessmentQuestionId, { name: "work.csv", data: CSV }, {}, at(T, 2));
    return { ...l, attemptId: view.attempt.id, mcq, written, upload };
  }
  return { admin, assessment, T, learner, startWithAnswers };
}

// ===========================================================================
describe("terminating one attempt", () => {
  it("an admin terminates a running attempt: TERMINATED with when/who/why; answers, files and history kept; audited", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    const before = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } });

    const result = await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: l.attemptId, reason: `  ${REASON}  ` }, at(T, 10));
    expect(result).toMatchObject({ attemptId: l.attemptId, terminatedAt: at(T, 10) });

    const after = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } });
    expect(after).toMatchObject({ status: "TERMINATED", terminatedAt: at(T, 10), terminatedById: admin.id, terminationReason: REASON, submittedAt: null, startedAt: before.startedAt, attemptNumber: 1 });
    // Answers and the uploaded file are untouched.
    const responses = await db.attemptResponse.findMany({ where: { attemptId: l.attemptId }, include: { attachments: { include: { file: true } } } });
    expect(responses.map((r) => r.textAnswer ?? r.selectedOptionIds[0]).sort()).toEqual([l.mcq.options[0].id, "My analysis"].sort());
    const file = responses.flatMap((r) => r.attachments)[0].file;
    expect(file).toMatchObject({ fileName: "work.csv", sizeBytes: CSV.length });
    expect(store.keys()).toContain(file.storageKey);
    // No new attempt was created.
    expect(await db.assessmentAttempt.count({ where: { candidateId: l.candidateId } })).toBe(1);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "attempt.terminated", entityId: l.attemptId } });
    expect(audit).toMatchObject({ actorId: admin.id, entityType: "AssessmentAttempt" });
    expect(audit.metadata).toMatchObject({ assessmentId: assessment.id, candidateId: l.candidateId, learnerId: l.user.id, reason: REASON, terminatedAt: at(T, 10).toISOString() });
  });

  it("only administrators can terminate (service and action)", async () => {
    const { assessment, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    for (const role of [Role.EXAMINER, Role.REVIEWER, Role.LEARNER]) {
      const actor = await createActor(role);
      await expect(terminateAttempt(actor, { assessmentId: assessment.id, attemptId: l.attemptId, reason: REASON })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(terminateAllActiveAttempts(actor, { assessmentId: assessment.id, reason: REASON })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const examiner = await createUser({ role: Role.EXAMINER });
    jar.set(SESSION_COOKIE_NAME, (await createSession(examiner.id)).token);
    expect(await redirectOf(actions.terminateAttemptAction(assessment.id, l.attemptId, REASON))).toBe("/forbidden");
    expect(await redirectOf(actions.terminateAllActiveAttemptsAction(assessment.id, REASON))).toBe("/forbidden");
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).status).toBe("IN_PROGRESS");
  });

  it("requires a reason, and the attempt must belong to the assessment", async () => {
    const { admin, assessment, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    for (const reason of [undefined, "", "   ", "ab"]) {
      await expect(terminateAttempt(admin, { assessmentId: assessment.id, attemptId: l.attemptId, reason })).rejects.toMatchObject({ fieldErrors: { reason: expect.any(Array) } });
    }
    await expect(terminateAllActiveAttempts(admin, { assessmentId: assessment.id, reason: "" })).rejects.toBeInstanceOf(ValidationError);
    const other = await scenario();
    await expect(terminateAttempt(admin, { assessmentId: other.assessment.id, attemptId: l.attemptId, reason: REASON })).rejects.toThrow(/not found/);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).status).toBe("IN_PROGRESS");
  });

  it("the learner is stopped: no saving, uploading, submitting or resuming; sees the terminated state and stays signed in", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: l.attemptId, reason: REASON }, at(T, 10));
    const N = at(T, 11);

    expect(await getMyAttemptClock(l.user, l.attemptId, N)).toEqual({ status: "TERMINATED", paused: false, locked: false, terminatedByFocus: false, remainingSeconds: 0 });
    await expect(saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.written.assessmentQuestionId, textAnswer: "late" }] }, N)).rejects.toThrow(TERMINATED_MESSAGE);
    await expect(uploadAnswerFile(l.user, l.attemptId, l.written.assessmentQuestionId, { name: "late.csv", data: CSV }, { replaceAttachmentId: l.upload.attachmentId }, N)).rejects.toThrow(TERMINATED_MESSAGE);
    await expect(submitAttempt(l.user, l.attemptId, {}, N)).rejects.toThrow(TERMINATED_MESSAGE);
    await expect(startOrResumeAttempt(l.user, N)).rejects.toThrow(/already taken this assessment/);
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId }, select: { status: true, submittedAt: true } })).toEqual({ status: "TERMINATED", submittedAt: null });
    expect((await db.attemptResponse.findFirstOrThrow({ where: { assessmentQuestionId: l.written.assessmentQuestionId } })).textAnswer).toBe("My analysis");

    // Still signed in; the overview shows the terminated attempt and nothing running.
    expect(await validateSessionToken(l.token, N)).toMatchObject({ id: l.user.id });
    const overview = await getMyExamOverview(l.user, N);
    expect(overview).toMatchObject({ inProgressAttemptId: null, canStart: false });
    expect(overview.attempts.map((a) => a.status)).toEqual(["TERMINATED"]);
    // Never a result: not scored, not "submitted"; the learner isn't shown the reason anywhere.
    const mine = await getMyResult(l.user, l.attemptId, N);
    expect(mine).toMatchObject({ resultState: "TERMINATED", result: null });
    expect(JSON.stringify(mine)).not.toContain("phone");
    expect(JSON.stringify(overview)).not.toContain("phone");
  });

  it("a submitted attempt can't be terminated, and a terminated one can't be terminated again", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario();
    const a = await startWithAnswers(0);
    await submitAttempt(a.user, a.attemptId, {}, at(T, 3));
    await expect(terminateAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, reason: REASON }, at(T, 4))).rejects.toThrow("This attempt has already been submitted.");
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).status).toBe("SUBMITTED");

    const b = await startWithAnswers(1);
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, reason: REASON }, at(T, 4));
    await expect(terminateAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, reason: REASON }, at(T, 5))).rejects.toThrow("This attempt has already been terminated.");
  });

  it("concurrent terminations: exactly one succeeds and one audit entry is written", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    const other = await createActor(Role.ADMIN);
    const results = await Promise.allSettled([admin, other, admin].map((actor) => terminateAttempt(actor, { assessmentId: assessment.id, attemptId: l.attemptId, reason: REASON }, at(T, 10))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "attempt.terminated", entityId: l.attemptId } })).toBe(1);
  });

  it("racing the learner's submit leaves exactly one outcome", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario();
    const l = await startWithAnswers(0);
    const [term, sub] = await Promise.allSettled([
      terminateAttempt(admin, { assessmentId: assessment.id, attemptId: l.attemptId, reason: REASON }, at(T, 10)),
      submitAttempt(l.user, l.attemptId, {}, at(T, 10)),
    ]);
    const status = (await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).status;
    expect(term.status === "fulfilled" ? status : "SUBMITTED").toBe(status);
    expect(sub.status === "fulfilled" ? "SUBMITTED" : "TERMINATED").toBe(status);
  });
});

// ===========================================================================
describe("terminating all active attempts", () => {
  it("terminates only running attempts; submitted stay submitted; nobody who never started gets an attempt; audited per attempt and in bulk", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario(4);
    const running1 = await startWithAnswers(0);
    const running2 = await startWithAnswers(1);
    const submitted = await startWithAnswers(2);
    await submitAttempt(submitted.user, submitted.attemptId, {}, at(T, 3));
    // Learner 4 never starts.

    expect(await terminateAllActiveAttempts(admin, { assessmentId: assessment.id, reason: REASON }, at(T, 10))).toMatchObject({ terminated: 2 });
    const attempts = await db.assessmentAttempt.findMany({ where: { assessmentId: assessment.id }, select: { id: true, status: true, terminationReason: true } });
    expect(attempts).toHaveLength(3);
    expect(Object.fromEntries(attempts.map((a) => [a.id, a.status]))).toEqual({ [running1.attemptId]: "TERMINATED", [running2.attemptId]: "TERMINATED", [submitted.attemptId]: "SUBMITTED" });
    expect(await db.assessmentCandidate.count({ where: { assessmentId: assessment.id, attempts: { none: {} } } })).toBe(1);

    const bulk = await db.auditLog.findFirstOrThrow({ where: { action: "attempt.bulk_terminated", entityId: assessment.id } });
    expect(bulk.metadata).toMatchObject({ reason: REASON, terminated: 2 });
    const each = await db.auditLog.findMany({ where: { action: "attempt.terminated" } });
    expect(each.map((e) => e.entityId).sort()).toEqual([running1.attemptId, running2.attemptId].sort());
    expect(each.every((e) => (e.metadata as { bulkOperationId?: string }).bulkOperationId === (bulk.metadata as { operationId: string }).operationId)).toBe(true);

    // Running it again changes nothing.
    expect(await terminateAllActiveAttempts(admin, { assessmentId: assessment.id, reason: REASON }, at(T, 11))).toMatchObject({ terminated: 0 });
  });

  it("a terminated attempt is never counted as submitted or scored by the results views", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario(2);
    const a = await startWithAnswers(0);
    await startWithAnswers(1);
    await terminateAllActiveAttempts(admin, { assessmentId: assessment.id, reason: REASON }, at(T, 10));
    const results = await listAssessmentResults(admin, assessment.id, at(T, 11));
    for (const c of results.candidates) {
      expect(c).toMatchObject({ resultStatus: "TERMINATED", best: null });
      expect(c.attempts[0]).toMatchObject({ status: "TERMINATED", final: false, obtained: null, passed: null });
    }
    expect(results.candidates.find((c) => c.attempts[0].attemptId === a.attemptId)).toBeDefined();
  });
});

// ===========================================================================
describe("termination and pause", () => {
  it("works while the assessment is paused, without resuming anything; a later resume doesn't touch the terminated attempt", async () => {
    const { admin, assessment, T, startWithAnswers } = await scenario(2);
    const a = await startWithAnswers(0);
    const b = await startWithAnswers(1);
    await pauseAssessment(admin, assessment.id, at(T, 10));
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, reason: REASON }, at(T, 12));
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("PAUSED");
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).status).toBe("TERMINATED");

    await resumeAssessment(admin, assessment.id, at(T, 20));
    const rows = await db.assessmentAttempt.findMany({ where: { assessmentId: assessment.id }, select: { id: true, status: true, pausedSeconds: true } });
    expect(rows.find((r) => r.id === a.attemptId)).toMatchObject({ status: "TERMINATED", pausedSeconds: 0 });
    expect(rows.find((r) => r.id === b.attemptId)).toMatchObject({ status: "IN_PROGRESS", pausedSeconds: 600 });

    // Paused → resumed → terminate also works.
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, reason: REASON }, at(T, 25));
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: b.attemptId } })).status).toBe("TERMINATED");
  });
});
