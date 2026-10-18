import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AssessmentAnalyticsView } from "@/components/analytics/assessment-analytics";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { getAssessmentAnalytics } from "@/server/services/analytics";
import { createAssessment, publishAssessment, transitionAssessment } from "@/server/services/assessments";
import { terminateAttempt } from "@/server/services/attempt-termination";
import { saveResponses, startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { finalizeEvaluation, getEvaluation, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { readFile, uploadAnswerFile } from "@/server/services/files";
import { getAttemptResult, getMyResult, listAssessmentResults } from "@/server/services/results";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * D2 — assessment analytics (admin: every candidate; examiner: their assigned candidates) and the
 * examiner's evaluation of an attempt. Every figure below is worked out by hand from the fixture.
 */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const questionsOf = (v: AttemptView) => v.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");

/**
 * Max 13: Q1 MCQ (2, −0.5), Q2 True/False (1), Q3 written answer + file (10). Batch X has 3 learners
 * (examiner e1), batch Y has 2 (examiner e2).
 *   x1: Q1 ✓ +2, Q2 ✓ +1, Q3 text + file → 8   = 11 (pass at 6)   — submitted after 30 min
 *   x2: Q1 ✗ −0.5, Q2 —, Q3 text → 3           = 2.5              — submitted after 20 min
 *   x3: started, then terminated by the admin
 *   y1: Q1 ✓ +2, Q2 ✗ 0, Q3 —                  = 2 (final at once) — submitted after 10 min
 *   y2: never started
 */
async function scenario(settings: Record<string, unknown> = {}, { finalize = true } = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        title: "Objective",
        questions: [
          mcqSingle({ text: "Recall uses?", marks: 2, negativeMarks: 0.5 }),
          mcqSingle({ text: "Precision ≤ 1", type: "TRUE_FALSE", marks: 1, negativeMarks: 0, options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }] }),
        ],
      },
      {
        title: "Written",
        questions: [{ ...shortAnswer({ type: "LONG_ANSWER", text: "Design a churn model; attach data.", marks: 10 }), response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false } }],
      },
    ],
  });
  const [bx, by] = [await createBatchWithLearners(course.id, 3), await createBatchWithLearners(course.id, 2)];
  await db.batch.update({ where: { id: bx.id }, data: { name: "Batch X" } });
  await db.batch.update({ where: { id: by.id }, data: { name: "Batch Y" } });
  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { name: "Churn Exam", type: "MIXED", paperId: paper.id, batchId: bx.id, startAt, endAt, durationMinutes: 60, passingMarks: 6, ...settings }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, bx.id);
  await assignBatchToAssessment(admin, assessment.id, by.id);
  const issued = await issueExamCredentials(admin, assessment.id);

  const members = async (batchId: string) => (await db.batchMember.findMany({ where: { batchId }, orderBy: { user: { email: "asc" } }, select: { userId: true } })).map((m) => m.userId);
  const [xs, ys] = [await members(bx.id), await members(by.id)];
  const candidates = await listCandidates(admin, assessment.id);
  const cand = (learnerId: string) => candidates.find((c) => c.learner.id === learnerId)!;
  const [e1, e2, e3] = [await createActor(Role.EXAMINER), await createActor(Role.EXAMINER), await createActor(Role.EXAMINER)];
  await assignExaminer(admin, assessment.id, xs.map((id) => cand(id).id), e1.id);
  await assignExaminer(admin, assessment.id, ys.map((id) => cand(id).id), e2.id);

  const T0 = at(startAt, 10);
  async function begin(learnerId: string) {
    const email = cand(learnerId).learner.email;
    const code = issued.find((i) => i.learner.email === email)!.code;
    const r = await authenticateExamCredential(email, code, {}, T0);
    if (!r.ok) throw new Error(r.reason);
    const me = (await validateSessionToken(r.token, T0))!;
    const view = await startOrResumeAttempt(me, T0);
    return { me, attemptId: view.attempt.id, q: questionsOf(view) };
  }

  // x1: everything right, with a file.
  const x1 = await begin(xs[0]);
  await saveResponses(x1.me, x1.attemptId, { responses: [{ assessmentQuestionId: x1.q[2].assessmentQuestionId, textAnswer: "Gradient boosting." }] }, at(T0, 2));
  const upload = await uploadAnswerFile(x1.me, x1.attemptId, x1.q[2].assessmentQuestionId, { name: "data.csv", data: Buffer.from("a,b\n1,2\n") }, {}, at(T0, 3));
  await submitAttempt(
    x1.me,
    x1.attemptId,
    {
      responses: [
        { assessmentQuestionId: x1.q[0].assessmentQuestionId, selectedOptionIds: [x1.q[0].options[1].id] },
        { assessmentQuestionId: x1.q[1].assessmentQuestionId, selectedOptionIds: [x1.q[1].options[0].id] },
        { assessmentQuestionId: x1.q[2].assessmentQuestionId, textAnswer: "Gradient boosting." },
      ],
    },
    at(T0, 30),
  );
  // x2: wrong MCQ, no True/False, a written answer.
  const x2 = await begin(xs[1]);
  await submitAttempt(
    x2.me,
    x2.attemptId,
    { responses: [{ assessmentQuestionId: x2.q[0].assessmentQuestionId, selectedOptionIds: [x2.q[0].options[0].id] }, { assessmentQuestionId: x2.q[2].assessmentQuestionId, textAnswer: "Logistic regression." }] },
    at(T0, 20),
  );
  // x3: terminated.
  const x3 = await begin(xs[2]);
  await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: x3.attemptId, reason: "Suspected impersonation" }, at(T0, 5));
  // y1: objective answers only — final on submission.
  const y1 = await begin(ys[0]);
  await submitAttempt(
    y1.me,
    y1.attemptId,
    { responses: [{ assessmentQuestionId: y1.q[0].assessmentQuestionId, selectedOptionIds: [y1.q[0].options[1].id] }, { assessmentQuestionId: y1.q[1].assessmentQuestionId, selectedOptionIds: [y1.q[1].options[1].id] }] },
    at(T0, 10),
  );

  const long = x1.q[2].assessmentQuestionId;
  await saveEvaluation(e1, x1.attemptId, { marks: [{ assessmentQuestionId: long, awardedMarks: 8, comment: "Solid design." }] });
  await finalizeEvaluation(e1, x1.attemptId);
  await saveEvaluation(e1, x2.attemptId, { marks: [{ assessmentQuestionId: long, awardedMarks: 3 }] });
  if (finalize) await finalizeEvaluation(e1, x2.attemptId);

  const N = at(T0, 60);
  return { admin, assessment, startAt, endAt, T0, N, e1, e2, e3, x1, x2, x3, y1, long, fileId: upload.file.id };
}

describe("assessment analytics", () => {
  it("1/4/5/6/7/9/10: admin sees counts, scores, pass and completion rates over every candidate", async () => {
    const s = await scenario();
    const a = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    expect(a.scope).toBe("ALL");
    expect(a.assessment).toMatchObject({ name: "Churn Exam", passingMarks: 6, maxMarks: 13 });
    expect(a.overview).toMatchObject({
      candidates: 5,
      attempted: 4,
      submitted: 3,
      evaluated: 3,
      pendingEvaluation: 0,
      averageScore: 5.17, // (11 + 2.5 + 2) / 3
      highestScore: 11,
      lowestScore: 2,
      passed: 1,
      passRate: 33.33,
      completionRate: 60, // 3 of 5 submitted
    });
    // 10: terminated attempts are counted but never as submissions.
    expect(a.attempts).toMatchObject({ started: 4, inProgress: 0, submitted: 3, autoSubmitted: 0, terminated: 1, locked: 0, averageDurationSeconds: 1200 });
  });

  it("8: no passing marks → no pass rate (not 100%, not 0%)", async () => {
    const s = await scenario({ passingMarks: 0 });
    const a = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    expect(a.assessment.passingMarks).toBeNull();
    expect(a.overview).toMatchObject({ passRate: null, passed: null, averageScore: 5.17 });
    expect(a.batches.every((b) => b.passRate === null)).toBe(true);
    const html = renderToStaticMarkup(createElement(AssessmentAnalyticsView, { data: a }));
    expect(html).toContain("No passing marks set");
  });

  it("11/12: question statistics from the final results; unanswered counted per question", async () => {
    const s = await scenario();
    const { questions } = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    expect(questions.map(({ number, section, kind, maxMarks, results, responses, correct, incorrect, unanswered, averageMarks, averagePercentage }) => ({ number, section, kind, maxMarks, results, responses, correct, incorrect, unanswered, averageMarks, averagePercentage }))).toEqual([
      { number: "1", section: "Objective", kind: "objective", maxMarks: 2, results: 3, responses: 3, correct: 2, incorrect: 1, unanswered: 0, averageMarks: 1.17, averagePercentage: 58.33 },
      { number: "2", section: "Objective", kind: "objective", maxMarks: 1, results: 3, responses: 2, correct: 1, incorrect: 1, unanswered: 1, averageMarks: 0.33, averagePercentage: 33.33 },
      { number: "3", section: "Written", kind: "subjective", maxMarks: 10, results: 3, responses: 2, correct: null, incorrect: null, unanswered: 1, averageMarks: 3.67, averagePercentage: 36.67 },
    ]);
  });

  it("13: batch performance", async () => {
    const s = await scenario();
    const { batches } = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    expect(batches.map(({ name, candidates, attempted, submitted, averageScore, highestScore, lowestScore, passRate, completionRate }) => ({ name, candidates, attempted, submitted, averageScore, highestScore, lowestScore, passRate, completionRate }))).toEqual([
      { name: "Batch X", candidates: 3, attempted: 3, submitted: 2, averageScore: 6.75, highestScore: 11, lowestScore: 2.5, passRate: 50, completionRate: 66.67 },
      { name: "Batch Y", candidates: 2, attempted: 1, submitted: 1, averageScore: 2, highestScore: 2, lowestScore: 2, passRate: 0, completionRate: 50 },
    ]);
  });

  it("pending evaluation: shown as pending, left out of scores and pass rate", async () => {
    const s = await scenario({}, { finalize: false });
    const a = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    expect(a.overview).toMatchObject({ submitted: 3, evaluated: 2, pendingEvaluation: 1, averageScore: 6.5, lowestScore: 2, passRate: 50 });
    expect(a.questions[0].results).toBe(2);
    expect(renderToStaticMarkup(createElement(AssessmentAnalyticsView, { data: a }))).toMatch(/Evaluation is pending for 1 candidate/);
  });

  it("2/3: examiners only for assessments where they have candidates — and only those candidates", async () => {
    const s = await scenario();
    const mine = await getAssessmentAnalytics(s.e1, s.assessment.id, s.N);
    expect(mine.scope).toBe("ASSIGNED");
    expect(mine.overview).toMatchObject({ candidates: 3, submitted: 2, averageScore: 6.75, passRate: 50 });
    expect(mine.attempts).toMatchObject({ started: 3, terminated: 1 });
    expect(mine.batches.map((b) => b.name)).toEqual(["Batch X"]);

    await expect(getAssessmentAnalytics(s.e3, s.assessment.id, s.N)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAssessmentAnalytics(s.e1, "made-up", s.N)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAssessmentAnalytics(s.x1.me, s.assessment.id, s.N)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAssessmentAnalytics(await createActor(Role.REVIEWER), s.assessment.id, s.N)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aggregates only: no learner names, emails, answers or feedback in the analytics", async () => {
    const s = await scenario();
    const a = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    const out = JSON.stringify(a) + renderToStaticMarkup(createElement(AssessmentAnalyticsView, { data: a }));
    const learners = await db.user.findMany({ where: { role: Role.LEARNER }, select: { email: true } });
    for (const l of learners) expect(out).not.toContain(l.email);
    for (const text of ["Gradient boosting", "Logistic regression", "Solid design", "data.csv", "Suspected impersonation"]) expect(out).not.toContain(text);
  });

  it("20/21: figures match the existing result calculation; the learner's own result is unchanged", async () => {
    const s = await scenario();
    const a = await getAssessmentAnalytics(s.admin, s.assessment.id, s.N);
    const list = await listAssessmentResults(s.admin, s.assessment.id, s.N);
    const bests = list.candidates.flatMap((c) => (c.best ? [c.best.obtained!] : []));
    expect(bests.sort()).toEqual([11, 2, 2.5].sort());
    expect(a.overview.highestScore).toBe(Math.max(...bests));
    expect((await getAttemptResult(s.admin, s.x1.attemptId)).result).toMatchObject({ obtained: 11, maxMarks: 13, complete: true });

    for (const to of ["EVALUATION", "RESULT_READY", "PUBLISHED"] as const) await transitionAssessment(s.admin, s.assessment.id, to, at(s.endAt, 10));
    expect((await getMyResult(s.x1.me, s.x1.attemptId, at(s.endAt, 11))).result).toMatchObject({ obtained: 11, maxMarks: 13, passed: true });
  });
});

describe("evaluation", () => {
  it("14/18: the assigned examiner marks and comments; both persist, update, and show in the evaluation", async () => {
    const s = await scenario({}, { finalize: false });
    await saveEvaluation(s.e1, s.x2.attemptId, { marks: [{ assessmentQuestionId: s.long, awardedMarks: 4.5, comment: "Name the features." }] });
    let ev = await getEvaluation(s.e1, s.x2.attemptId);
    expect(ev.questions.find((q) => q.assessmentQuestionId === s.long)).toMatchObject({ awarded: 4.5, examinerComment: "Name the features.", status: "PARTIALLY_CORRECT" });
    expect(ev.attempt).toMatchObject({ status: "SUBMITTED", timeTakenSeconds: 1200 });
    expect(ev.learner.email).toEqual(expect.any(String));

    await saveEvaluation(s.e1, s.x2.attemptId, { marks: [{ assessmentQuestionId: s.long, awardedMarks: 10, comment: "Revised: complete." }] });
    ev = await getEvaluation(s.e1, s.x2.attemptId);
    expect(ev.questions.find((q) => q.assessmentQuestionId === s.long)).toMatchObject({ awarded: 10, examinerComment: "Revised: complete.", status: "EVALUATED" });
    expect(ev.questions.map((q) => q.status)).toEqual(["INCORRECT", "UNANSWERED", "EVALUATED"]);
  });

  it("15: another examiner's candidate can't be read or marked", async () => {
    const s = await scenario({}, { finalize: false });
    await expect(getEvaluation(s.e2, s.x2.attemptId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveEvaluation(s.e2, s.x2.attemptId, { marks: [{ assessmentQuestionId: s.long, awardedMarks: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveEvaluation(s.e3, s.x2.attemptId, { marks: [{ assessmentQuestionId: s.long, awardedMarks: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.attemptResponse.findFirstOrThrow({ where: { attemptId: s.x2.attemptId, assessmentQuestionId: s.long } })).awardedMarks?.toNumber()).toBe(3);
  });

  it("16/17: marks above the maximum or below 0 are refused by the server", async () => {
    const s = await scenario({}, { finalize: false });
    for (const awardedMarks of [10.5, 11, -1, -0.01, "abc"]) {
      await expect(saveEvaluation(s.e1, s.x2.attemptId, { marks: [{ assessmentQuestionId: s.long, awardedMarks }] })).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await db.attemptResponse.findFirstOrThrow({ where: { attemptId: s.x2.attemptId, assessmentQuestionId: s.long } })).awardedMarks?.toNumber()).toBe(3);
  });

  it("19: file answers open for the assigned examiner and admin, not for other examiners", async () => {
    const s = await scenario();
    const ev = await getEvaluation(s.e1, s.x1.attemptId);
    expect(ev.questions[2].answer.files).toEqual([expect.objectContaining({ id: s.fileId, fileName: "data.csv", extension: "csv" })]);
    expect((await readFile(s.e1, s.fileId)).data.toString()).toBe("a,b\n1,2\n");
    expect((await readFile(s.admin, s.fileId)).file.fileName).toBe("data.csv");
    await expect(readFile(s.e2, s.fileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readFile(s.e3, s.fileId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
