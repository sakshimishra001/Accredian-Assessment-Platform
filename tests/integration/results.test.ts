import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, getAssessment, publishAssessment, transitionAssessment } from "@/server/services/assessments";
import { saveResponses, startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { finalizeEvaluation, getEvaluation, listMyEvaluations, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { getAttemptResult, getMyResult, getMyResults, listAssessmentResults, reopenEvaluation } from "@/server/services/results";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const expectError = (p: Promise<unknown>, type: new (...args: never[]) => Error) => expect(p).rejects.toBeInstanceOf(type);
const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const questionsOf = (v: AttemptView) => v.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");

/**
 * MIXED assessment, max 21 marks: Section A — MCQ single (2, −0.5), MCQ multi (3, −1), True/False (1);
 * Section B — short answer (5), long answer (10). Two learners, each assigned to a different examiner.
 */
async function scenario(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        title: "Section A",
        questions: [
          mcqSingle({ text: "Single", marks: 2, negativeMarks: 0.5 }),
          mcqSingle({ text: "Multi", type: "MCQ_MULTI", marks: 3, negativeMarks: 1, options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }] }),
          mcqSingle({ text: "TF", type: "TRUE_FALSE", marks: 1, negativeMarks: 0, options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }] }),
        ],
      },
      { title: "Section B", questions: [shortAnswer({ text: "Define recall.", marks: 5, guidance: "TP / (TP + FN)" }), shortAnswer({ type: "LONG_ANSWER", text: "Design a churn model.", marks: 10 })] },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { name: "AI Final Exam", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt, durationMinutes: 60, passingMarks: 10, ...settings }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const [e1, e2] = [await createActor(Role.EXAMINER), await createActor(Role.EXAMINER)];
  const candidates = (await listCandidates(admin, assessment.id)).sort((a, b) => a.learner.name.localeCompare(b.learner.name));
  await assignExaminer(admin, assessment.id, [candidates[0].id], e1.id);
  await assignExaminer(admin, assessment.id, [candidates[1].id], e2.id);
  const T0 = at(startAt, 10);

  async function examLogin(email: string): Promise<SessionUser> {
    const code = issued.find((i) => i.learner.email === email)!.code;
    const r = await authenticateExamCredential(email, code, {}, T0);
    if (!r.ok) throw new Error(r.reason);
    return (await validateSessionToken(r.token, T0))!;
  }
  return { admin, course, assessment, startAt, endAt, T0, e1, e2, learnerA: candidates[0].learner, learnerB: candidates[1].learner, examLogin };
}

/** Learner A's answers: single ✓ (+2), multi ✗ (−1), TF unanswered, both written answers given. */
async function takeA(s: Awaited<ReturnType<typeof scenario>>) {
  const me = await s.examLogin(s.learnerA.email);
  const view = await startOrResumeAttempt(me, s.T0);
  const [single, multi, , short, long] = questionsOf(view);
  await submitAttempt(
    me,
    view.attempt.id,
    {
      responses: [
        { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id] },
        { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id] },
        { assessmentQuestionId: short.assessmentQuestionId, textAnswer: "Share of actual positives found." },
        { assessmentQuestionId: long.assessmentQuestionId, textAnswer: "Gradient boosting on usage features…" },
      ],
    },
    at(s.T0, 30),
  );
  return { me, attemptId: view.attempt.id, short, long, single };
}

/** Learner B answers nothing written, so their attempt needs no examiner. */
async function takeB(s: Awaited<ReturnType<typeof scenario>>) {
  const me = await s.examLogin(s.learnerB.email);
  const view = await startOrResumeAttempt(me, s.T0);
  await submitAttempt(me, view.attempt.id, {}, at(s.T0, 20));
  return { me, attemptId: view.attempt.id };
}

const mark = (short: ExamQuestion, long: ExamQuestion, a: number, b: number) => ({
  marks: [
    { assessmentQuestionId: short.assessmentQuestionId, awardedMarks: a, comment: "Good definition" },
    { assessmentQuestionId: long.assessmentQuestionId, awardedMarks: b },
  ],
});

// ---------------------------------------------------------------------------
describe("objective-only assessments", () => {
  it("score on submission, with IMMEDIATE visibility showing the result at once", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createReadyPaper(admin, course.id, { sections: [{ questions: [mcqSingle({ text: "A", marks: 2, negativeMarks: 0.5 }), mcqSingle({ text: "B", marks: 2, negativeMarks: 0.5 })] }] });
    const batch = await createBatchWithLearners(course.id, 1);
    const startAt = hoursFromNow(1);
    const assessment = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: hoursFromNow(3), resultVisibility: "IMMEDIATE", resultDetail: "SCORE_AND_ANSWERS", passingMarks: 1 }));
    await publishAssessment(admin, assessment.id);
    await assignBatchToAssessment(admin, assessment.id, batch.id);
    const [cred] = await issueExamCredentials(admin, assessment.id);
    const login = await authenticateExamCredential(cred.learner.email, cred.code, {}, at(startAt, 5));
    if (!login.ok) throw new Error(login.reason);
    const me = (await validateSessionToken(login.token, at(startAt, 5)))!;
    const view = await startOrResumeAttempt(me, at(startAt, 5));
    const [a, b] = questionsOf(view);
    await submitAttempt(me, view.attempt.id, { responses: [{ assessmentQuestionId: a.assessmentQuestionId, selectedOptionIds: [a.options[1].id] }, { assessmentQuestionId: b.assessmentQuestionId, selectedOptionIds: [b.options[0].id] }] }, at(startAt, 10));

    const mine = await getMyResult(me, view.attempt.id, at(startAt, 11));
    expect(mine.resultState).toBe("AVAILABLE");
    expect(mine.result).toMatchObject({ maxMarks: 4, obtained: 1.5, percentage: 37.5, passed: true });
    expect(mine.result?.questions?.map((q) => [q.outcome, q.awarded])).toEqual([
      ["correct", 2],
      ["incorrect", -0.5],
    ]);
    expect(mine.result?.questions?.[1].correctOptionIds).toEqual([b.options[1].id]);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: view.attempt.id } })).evaluationStatus).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
describe("subjective evaluation", () => {
  it("written answers enter pending evaluation for the assigned examiner only", async () => {
    const s = await scenario();
    const { attemptId } = await takeA(s);
    await takeB(s);

    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).evaluationStatus).toBe("PENDING");
    const queue = await listMyEvaluations(s.e1, { assessmentId: s.assessment.id });
    expect(queue.map((x) => [x.learner.email, x.evaluationStatus, x.pending])).toEqual([[s.learnerA.email, "PENDING", 2]]);
    expect(await listMyEvaluations(s.e2)).toEqual([expect.objectContaining({ learner: expect.objectContaining({ email: s.learnerB.email }), evaluationStatus: "COMPLETED", pending: 0 })]);

    const ev = await getEvaluation(s.e1, attemptId);
    expect(ev.canEdit).toBe(true);
    expect(ev.questions.map((q) => [q.number, q.kind, q.outcome, q.awarded, q.needsMarks])).toEqual([
      ["1", "objective", "correct", 2, false],
      ["2", "objective", "incorrect", -1, false],
      ["3", "objective", "unanswered", 0, false],
      ["4", "subjective", "pending", null, true],
      ["5", "subjective", "pending", null, true],
    ]);
    expect(ev.questions[3]).toMatchObject({ guidance: "TP / (TP + FN)", answer: { textAnswer: "Share of actual positives found." }, maxMarks: 5 });
    await expectError(getEvaluation(s.e2, attemptId), NotFoundError);
  });

  it("validates marks: within 0..max, numeric, written answers only", async () => {
    const s = await scenario();
    const { attemptId, short, long, single } = await takeA(s);
    const bad = (marks: Record<string, unknown>[]) => expectError(saveEvaluation(s.e1, attemptId, { marks }), ValidationError);
    await bad([{ assessmentQuestionId: short.assessmentQuestionId, awardedMarks: 6 }]);
    await bad([{ assessmentQuestionId: short.assessmentQuestionId, awardedMarks: -1 }]);
    await bad([{ assessmentQuestionId: short.assessmentQuestionId, awardedMarks: "lots" }]);
    await bad([{ assessmentQuestionId: short.assessmentQuestionId, awardedMarks: 2.555 }]);
    await bad([{ assessmentQuestionId: single.assessmentQuestionId, awardedMarks: 0 }]); // objective: scored automatically
    await bad([{ assessmentQuestionId: "foreign-question", awardedMarks: 1 }]);
    expect(await db.attemptResponse.count({ where: { awardedMarks: { not: null } } })).toBe(0);
    // Boundary values are accepted.
    await expect(saveEvaluation(s.e1, attemptId, mark(short, long, 0, 10))).resolves.toEqual({ saved: 2 });
  });

  it("saves progressively, refuses to finalize with gaps, then finalizes and locks", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);

    await saveEvaluation(s.e1, attemptId, { marks: [{ assessmentQuestionId: short.assessmentQuestionId, awardedMarks: 3 }] });
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).evaluationStatus).toBe("IN_PROGRESS");
    await expect(finalizeEvaluation(s.e1, attemptId)).rejects.toThrow(/Enter marks for Q5/);

    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId, at(s.T0, 300));

    const row = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(row).toMatchObject({ evaluationStatus: "COMPLETED", evaluationFinalizedById: s.e1.id });
    const response = await db.attemptResponse.findFirstOrThrow({ where: { assessmentQuestionId: short.assessmentQuestionId } });
    expect(response).toMatchObject({ evaluatedById: s.e1.id, examinerComment: "Good definition" });
    expect(response.awardedMarks?.toNumber()).toBe(4);
    await expectError(saveEvaluation(s.e1, attemptId, mark(short, long, 5, 10)), ConflictError);
    await expectError(finalizeEvaluation(s.e1, attemptId), ConflictError);
    expect(await db.auditLog.count({ where: { action: AuditAction.EVALUATION_FINALIZED } })).toBe(1);
  });

  it("concurrent marking can't corrupt marks; only one finalize wins", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    await Promise.all([saveEvaluation(s.e1, attemptId, mark(short, long, 1, 1)), saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7))]);
    // The two saves are serialised: the stored marks are entirely one save's, never a mix.
    const marks = (await db.attemptResponse.findMany({ where: { awardedMarks: { not: null } } })).map((r) => r.awardedMarks!.toNumber()).sort((x, y) => x - y);
    expect([
      [1, 1],
      [4, 7],
    ]).toContainEqual(marks);
    const results = await Promise.allSettled([finalizeEvaluation(s.e1, attemptId), finalizeEvaluation(s.e1, attemptId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("results", () => {
  it("combine objective, negative and subjective marks; stay unavailable while evaluation is pending", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    await takeB(s);

    let list = await listAssessmentResults(s.admin, s.assessment.id, at(s.T0, 40));
    const a = () => list.candidates.find((c) => c.learner.id === s.learnerA.id)!;
    const b = () => list.candidates.find((c) => c.learner.id === s.learnerB.id)!;
    expect(a()).toMatchObject({ resultStatus: "EVALUATION_PENDING", best: null, attempts: [expect.objectContaining({ evaluationStatus: "PENDING", obtained: null, provisional: 1, maxMarks: 21, pendingAnswers: 2 })] });
    // B: single unanswered etc. — objective-only answers, final immediately (0 marks).
    expect(b()).toMatchObject({ resultStatus: "FINAL", best: { obtained: 0, passed: false } });

    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    list = await listAssessmentResults(s.admin, s.assessment.id, at(s.T0, 40));
    expect(a()).toMatchObject({ resultStatus: "FINAL", best: { obtained: 12, percentage: 57.14, passed: true } });

    const detail = await getAttemptResult(s.admin, attemptId);
    expect(detail.result).toMatchObject({ complete: true, obtained: 12, objectiveMarks: 1, subjectiveMarks: 11, negativeMarks: 1, counts: { answered: 4, unanswered: 1, correct: 1, incorrect: 1, evaluated: 2 } });
    expect(detail.questions[3].evaluatedBy).toMatchObject({ id: s.e1.id });
    expect(list.assessment).toMatchObject({ name: "AI Final Exam", batch: expect.objectContaining({ id: expect.any(String) }) });
  });

  it("results can't be marked ready while attempts are pending evaluation", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    const afterEnd = at(s.endAt, 10);
    await transitionAssessment(s.admin, s.assessment.id, "EVALUATION", afterEnd);
    await expect(transitionAssessment(s.admin, s.assessment.id, "RESULT_READY", afterEnd)).rejects.toThrow(/1 attempt\(s\) still need evaluation/);
    expect((await getAssessment(s.admin, s.assessment.id, afterEnd)).actions.find((x) => x.to === "RESULT_READY")?.check.ok).toBe(false);

    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    await transitionAssessment(s.admin, s.assessment.id, "RESULT_READY", afterEnd);
  });

  it("ON_PUBLISH: hidden from the learner until the admin publishes results", async () => {
    const s = await scenario({ resultDetail: "SCORE" });
    const { me, attemptId, short, long } = await takeA(s);
    expect((await getMyResult(me, attemptId, at(s.T0, 31))).resultState).toBe("EVALUATION_PENDING");

    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    const awaiting = await getMyResult(me, attemptId, at(s.T0, 31));
    expect(awaiting).toMatchObject({ resultState: "AWAITING_PUBLICATION", result: null });

    const afterEnd = at(s.endAt, 10);
    await transitionAssessment(s.admin, s.assessment.id, "EVALUATION", afterEnd);
    await transitionAssessment(s.admin, s.assessment.id, "RESULT_READY", afterEnd);
    await transitionAssessment(s.admin, s.assessment.id, "PUBLISHED", afterEnd);

    const published = await getMyResults(me, afterEnd);
    expect(published.attempts[0]).toMatchObject({ resultState: "AVAILABLE", result: { maxMarks: 21, obtained: 12, percentage: 57.14, passed: true, questions: null } });
    const json = JSON.stringify(published);
    expect(json).not.toContain("isCorrect");
    expect(json).not.toContain("TP / (TP + FN)");
    expect(json).not.toContain("Good definition");
  });

  it("FULL_FEEDBACK shows marks, correct options, comments and explanations once visible", async () => {
    const s = await scenario({ resultDetail: "FULL_FEEDBACK" });
    const { me, attemptId, short, long } = await takeA(s);
    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    const afterEnd = at(s.endAt, 10);
    for (const to of ["EVALUATION", "RESULT_READY", "PUBLISHED"] as const) await transitionAssessment(s.admin, s.assessment.id, to, afterEnd);

    const r = await getMyResult(me, attemptId, afterEnd);
    expect(r.result?.questions?.[3]).toMatchObject({ number: "4", awarded: 4, maxMarks: 5, examinerComment: "Good definition", explanation: "TP / (TP + FN)", correctOptionIds: null });
    expect(r.result?.questions?.[1]).toMatchObject({ outcome: "incorrect", awarded: -1, correctOptionIds: expect.arrayContaining([expect.any(String)]) });
  });
});

// ---------------------------------------------------------------------------
describe("security", () => {
  it("a learner can only see their own result", async () => {
    const s = await scenario();
    const { attemptId } = await takeA(s);
    const { me: b } = await takeB(s);
    await expectError(getMyResult(b, attemptId, at(s.T0, 40)), NotFoundError);
    await expectError(getMyResult(b, "made-up", at(s.T0, 40)), NotFoundError);
    expect((await getMyResults(b, at(s.T0, 40))).attempts).toHaveLength(1);
  });

  it("examiners stay within their own candidates and can't publish or read admin results", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    await expectError(saveEvaluation(s.e2, attemptId, mark(short, long, 4, 7)), NotFoundError);
    await expectError(finalizeEvaluation(s.e2, attemptId), NotFoundError);
    await expectError(getAttemptResult(s.e1, attemptId), ForbiddenError);
    await expectError(listAssessmentResults(s.e1, s.assessment.id), ForbiddenError);
    await expectError(transitionAssessment(s.e1, s.assessment.id, "EVALUATION"), ForbiddenError);
    await expectError(reopenEvaluation(s.e1, attemptId, { reason: "Want to redo it" }), ForbiddenError);
  });

  it("learners, reviewers and admins can't mark; learners can't touch results", async () => {
    const s = await scenario();
    const { me, attemptId, short, long } = await takeA(s);
    for (const actor of [me, s.admin, await createActor(Role.REVIEWER)]) {
      await expectError(saveEvaluation(actor, attemptId, mark(short, long, 5, 10)), ForbiddenError);
      await expectError(finalizeEvaluation(actor, attemptId), ForbiddenError);
      await expectError(getEvaluation(actor, attemptId), ForbiddenError);
    }
    await expectError(reopenEvaluation(me, attemptId, { reason: "Please re-mark" }), ForbiddenError);
    await expectError(listAssessmentResults(me, s.assessment.id), ForbiddenError);
  });

  it("an examiner whose candidate is reassigned loses access immediately", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    const candidate = (await listCandidates(s.admin, s.assessment.id)).find((c) => c.learner.id === s.learnerA.id)!;
    await assignExaminer(s.admin, s.assessment.id, [candidate.id], s.e2.id);
    await expectError(saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7)), NotFoundError);
    await expect(saveEvaluation(s.e2, attemptId, mark(short, long, 4, 7))).resolves.toEqual({ saved: 2 });
  });
});

// ---------------------------------------------------------------------------
describe("immutability", () => {
  it("submitted answers can't change; evaluation can't change after finalizing except via admin reopen", async () => {
    const s = await scenario();
    const { me, attemptId, short, long } = await takeA(s);
    await expect(saveResponses(me, attemptId, { responses: [{ assessmentQuestionId: short.assessmentQuestionId, textAnswer: "Edited later" }] }, at(s.T0, 35))).rejects.toThrow(/already been submitted/);

    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    const before = await getAttemptResult(s.admin, attemptId);

    await expectError(reopenEvaluation(s.admin, attemptId, { reason: "no" }), ValidationError);
    await reopenEvaluation(s.admin, attemptId, { reason: "Q5 was marked against the wrong rubric." });
    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 9));
    await finalizeEvaluation(s.e1, attemptId);
    const after = await getAttemptResult(s.admin, attemptId);
    expect([before.result.obtained, after.result.obtained]).toEqual([12, 14]);
    expect(after.questions[3].answer.textAnswer).toBe("Share of actual positives found.");
    expect(await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.EVALUATION_REOPENED } })).toMatchObject({ actorId: s.admin.id });
  });

  it("once results are published the evaluation can't be reopened and the result stays the same", async () => {
    const s = await scenario();
    const { attemptId, short, long } = await takeA(s);
    await saveEvaluation(s.e1, attemptId, mark(short, long, 4, 7));
    await finalizeEvaluation(s.e1, attemptId);
    const afterEnd = at(s.endAt, 10);
    await transitionAssessment(s.admin, s.assessment.id, "EVALUATION", afterEnd);
    await transitionAssessment(s.admin, s.assessment.id, "RESULT_READY", afterEnd);
    await expect(reopenEvaluation(s.admin, attemptId, { reason: "Late correction" })).rejects.toThrow(/back to evaluation/);
    await transitionAssessment(s.admin, s.assessment.id, "PUBLISHED", afterEnd);
    await expect(reopenEvaluation(s.admin, attemptId, { reason: "Late correction" })).rejects.toThrow(/already published/);
    const one = await getAttemptResult(s.admin, attemptId);
    const two = await getAttemptResult(s.admin, attemptId);
    expect(one.result).toEqual(two.result);
    expect(one.result.obtained).toBe(12);
  });
});
