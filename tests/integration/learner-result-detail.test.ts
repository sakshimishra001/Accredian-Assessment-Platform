import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment, transitionAssessment } from "@/server/services/assessments";
import { saveResponses, startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { finalizeEvaluation, getEvaluation, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { readFile, uploadAnswerFile } from "@/server/services/files";
import { getAttemptResult, getMyResult, getMyResults, listAssessmentResults } from "@/server/services/results";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * D1 — the learner's detailed result: who sat it and when, the server's marks, and a question-wise
 * breakdown, only for the learner's own attempt and only once results are visible.
 */

// The page's sign-in check returns the learner under test; notFound() becomes a catchable signal.
let signedIn: SessionUser | null = null;
vi.mock("@/server/auth/guards", () => ({ requireRole: async () => signedIn }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
const { default: MyResultPage } = await import("@/app/learner/(portal)/results/[attemptId]/page");

beforeEach(async () => {
  signedIn = null;
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const questionsOf = (v: AttemptView) => v.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");

async function renderPage(me: SessionUser, attemptId: string) {
  signedIn = me;
  const el = (await MyResultPage({ params: Promise.resolve({ attemptId }) } as never)) as ReactElement;
  return renderToStaticMarkup(createElement(() => el));
}

/**
 * MIXED, max 21: Section A — MCQ single (2, −0.5), MCQ multi (3, −1), True/False (1);
 * Section B — short answer (5, with explanation), written answer + file (10).
 */
async function scenario(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        title: "Fundamentals",
        questions: [
          mcqSingle({ text: "Which metric uses TP and FN?", marks: 2, negativeMarks: 0.5 }),
          mcqSingle({ text: "Pick the supervised methods", type: "MCQ_MULTI", marks: 3, negativeMarks: 1, options: [{ text: "Regression", isCorrect: true }, { text: "Classification", isCorrect: true }, { text: "Clustering", isCorrect: false }] }),
          mcqSingle({ text: "Recall can exceed 1", type: "TRUE_FALSE", marks: 1, negativeMarks: 0, options: [{ text: "True", isCorrect: false }, { text: "False", isCorrect: true }] }),
        ],
      },
      {
        title: "Applied <ML>",
        questions: [
          shortAnswer({ text: "Define recall.", marks: 5, guidance: "TP / (TP + FN)" }),
          { ...shortAnswer({ type: "LONG_ANSWER", text: "Design a churn model and attach your data.", marks: 10 }), response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false } },
        ],
      },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { name: "AI Final Exam", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt, durationMinutes: 60, passingMarks: 10, resultDetail: "FULL_FEEDBACK", ...settings }),
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
  const publish = async () => {
    for (const to of ["EVALUATION", "RESULT_READY", "PUBLISHED"] as const) await transitionAssessment(admin, assessment.id, to, at(endAt, 10));
  };
  return { admin, assessment, startAt, endAt, T0, e1, e2, learnerA: candidates[0].learner, learnerB: candidates[1].learner, examLogin, publish };
}

/**
 * Learner A: single ✓ (+2), multi ✗ (−1), TF unanswered, a short answer, and a written answer with a
 * CSV attached — submitted 30 minutes after starting. Their examiner then marks 5/5 and 6/10.
 */
async function takeA(s: Awaited<ReturnType<typeof scenario>>, { finalize = true } = {}) {
  const me = await s.examLogin(s.learnerA.email);
  const view = await startOrResumeAttempt(me, s.T0);
  const [single, multi, , short, long] = questionsOf(view);
  const longAnswer = "Line one <script>alert(1)</script>\nLine two " + "x".repeat(3000);
  await saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: long.assessmentQuestionId, textAnswer: longAnswer }] }, at(s.T0, 5));
  const file = await uploadAnswerFile(me, view.attempt.id, long.assessmentQuestionId, { name: "churn.csv", data: Buffer.from("user,churned\n1,0\n") }, {}, at(s.T0, 6));
  await submitAttempt(
    me,
    view.attempt.id,
    {
      responses: [
        { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id] },
        { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id] },
        { assessmentQuestionId: short.assessmentQuestionId, textAnswer: "Share of actual positives found." },
        { assessmentQuestionId: long.assessmentQuestionId, textAnswer: longAnswer },
      ],
    },
    at(s.T0, 30),
  );
  if (finalize) {
    await saveEvaluation(s.e1, view.attempt.id, {
      marks: [
        { assessmentQuestionId: short.assessmentQuestionId, awardedMarks: 5, comment: "Precise <b>definition</b>" },
        { assessmentQuestionId: long.assessmentQuestionId, awardedMarks: 6, comment: "Good features; validation is missing." },
      ],
    });
    await finalizeEvaluation(s.e1, view.attempt.id);
  }
  const fileId = file.file.id;
  return { me, attemptId: view.attempt.id, single, multi, short, long, longAnswer, fileId };
}

async function takeB(s: Awaited<ReturnType<typeof scenario>>) {
  const me = await s.examLogin(s.learnerB.email);
  const view = await startOrResumeAttempt(me, s.T0);
  await submitAttempt(me, view.attempt.id, {}, at(s.T0, 20));
  return { me, attemptId: view.attempt.id };
}

describe("learner detailed result (service)", () => {
  it("1/4/5/6/7/8/9/10/11/12: own published result — candidate, assessment, marks, percentage and every question", async () => {
    const s = await scenario();
    const a = await takeA(s);
    await s.publish();
    const r = await getMyResult(a.me, a.attemptId, at(s.endAt, 11));

    expect(r.resultState).toBe("AVAILABLE");
    // 4: candidate — from the session's own attempt.
    expect(r.candidate).toEqual({ name: s.learnerA.name, email: s.learnerA.email });
    // 5: assessment and attempt timing (30 minutes from start to submission).
    expect(r.assessment).toMatchObject({ id: s.assessment.id, name: "AI Final Exam", startAt: s.startAt, durationMinutes: 60 });
    expect(r).toMatchObject({ attemptNumber: 1, status: "SUBMITTED", startedAt: s.T0, submittedAt: at(s.T0, 30), timeTakenSeconds: 1800 });
    // 6/7: 2 − 1 + 0 + 5 + 6 = 12 of 21 → 57.14%; passing marks 10 → passed.
    expect(r.result).toMatchObject({
      maxMarks: 21,
      obtained: 12,
      percentage: 57.14,
      passingMarks: 10,
      passed: true,
      questionCount: 5,
      answered: 4,
      unanswered: 1,
      correct: 1,
      incorrect: 1,
      partiallyCorrect: 1,
      evaluated: 2,
    });

    // 8: every question, numbered, with its section and full text.
    const q = r.result!.questions!;
    expect(q.map((x) => [x.number, x.section, x.status, x.awarded, x.maxMarks])).toEqual([
      ["1", "Fundamentals", "CORRECT", 2, 2],
      ["2", "Fundamentals", "INCORRECT", -1, 3],
      ["3", "Fundamentals", "UNANSWERED", 0, 1],
      ["4", "Applied <ML>", "EVALUATED", 5, 5],
      ["5", "Applied <ML>", "PARTIALLY_CORRECT", 6, 10],
    ]);
    // 9: objective — the learner's selection and the correct option(s).
    expect(q[0]).toMatchObject({ text: "Which metric uses TP and FN?", yourAnswer: { selectedOptionIds: [a.single.options[1].id] }, correctOptionIds: [a.single.options[1].id] });
    expect(q[1].yourAnswer.selectedOptionIds).toEqual([a.multi.options[0].id]);
    expect(q[1].correctOptionIds).toEqual(expect.arrayContaining([a.multi.options[0].id, a.multi.options[1].id]));
    // 10/11/12: written answers exactly as saved, examiner feedback and the uploaded file's details.
    expect(q[3]).toMatchObject({ yourAnswer: { textAnswer: "Share of actual positives found.", files: [] }, examinerComment: "Precise <b>definition</b>", explanation: "TP / (TP + FN)", correctOptionIds: null });
    expect(q[4].yourAnswer.textAnswer).toBe(a.longAnswer);
    expect(q[4].yourAnswer.files).toEqual([{ id: a.fileId, fileName: "churn.csv", extension: "csv", sizeBytes: 17 }]);
    expect(q[4].examinerComment).toBe("Good features; validation is missing.");
  });

  it("result settings still decide how much is shown: SCORE shares totals only", async () => {
    const s = await scenario({ resultDetail: "SCORE" });
    const a = await takeA(s);
    await s.publish();
    const r = await getMyResult(a.me, a.attemptId, at(s.endAt, 11));
    expect(r.result).toMatchObject({ obtained: 12, percentage: 57.14, questions: null });
    const json = JSON.stringify(r);
    for (const hidden of ["Precise", "TP / (TP + FN)", "churn.csv", "isCorrect"]) expect(json).not.toContain(hidden);

    // SCORE_AND_ANSWERS: answers and correct options, but no feedback or explanation.
    await resetDatabase();
    const s2 = await scenario({ resultDetail: "SCORE_AND_ANSWERS" });
    const a2 = await takeA(s2);
    await s2.publish();
    const r2 = await getMyResult(a2.me, a2.attemptId, at(s2.endAt, 11));
    expect(r2.result?.questions?.[0].correctOptionIds).toEqual([a2.single.options[1].id]);
    expect(JSON.stringify(r2)).not.toContain("Precise");
    expect(r2.result?.questions?.[3]).not.toHaveProperty("examinerComment");
  });

  it("pass / fail only when passing marks are set", async () => {
    const s = await scenario({ passingMarks: 0 });
    const a = await takeA(s);
    await s.publish();
    expect((await getMyResult(a.me, a.attemptId, at(s.endAt, 11))).result).toMatchObject({ obtained: 12, passingMarks: null, passed: null });
  });

  it("2: another learner's result (or a made-up id) is not found", async () => {
    const s = await scenario();
    const a = await takeA(s);
    const b = await takeB(s);
    await s.publish();
    await expect(getMyResult(b.me, a.attemptId, at(s.endAt, 11))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyResult(b.me, "made-up", at(s.endAt, 11))).rejects.toBeInstanceOf(NotFoundError);
    expect((await getMyResults(b.me, at(s.endAt, 11))).attempts.map((x) => x.attemptId)).toEqual([b.attemptId]);
  });

  it("3: before publication nothing is revealed — no marks, answers, feedback or files", async () => {
    const s = await scenario();
    const a = await takeA(s);
    const r = await getMyResult(a.me, a.attemptId, at(s.T0, 40));
    expect(r).toMatchObject({ resultState: "AWAITING_PUBLICATION", result: null });
    const json = JSON.stringify(r);
    for (const hidden of ["Precise", "Good features", "churn.csv", "TP / (TP + FN)", "\"obtained\""]) expect(json).not.toContain(hidden);
  });

  it("15: pending evaluation is shown as pending, with no marks", async () => {
    const s = await scenario({ resultVisibility: "ON_PUBLISH" });
    const a = await takeA(s, { finalize: false });
    const r = await getMyResult(a.me, a.attemptId, at(s.T0, 40));
    expect(r).toMatchObject({ resultState: "EVALUATION_PENDING", result: null, status: "SUBMITTED", timeTakenSeconds: 1800 });
  });

  it("13/14: answer files open for their owner (and assigned examiner / admin) only", async () => {
    const s = await scenario();
    const a = await takeA(s);
    const b = await takeB(s);
    await s.publish();
    expect((await readFile(a.me, a.fileId)).data.toString()).toBe("user,churned\n1,0\n");
    expect((await readFile(s.e1, a.fileId)).file.fileName).toBe("churn.csv");
    expect((await readFile(s.admin, a.fileId)).file.fileName).toBe("churn.csv");
    await expect(readFile(b.me, a.fileId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readFile(s.e2, a.fileId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("16/17: the learner's figures are the existing calculation's; admin and examiner access is unchanged", async () => {
    const s = await scenario();
    const a = await takeA(s);
    await s.publish();
    const mine = (await getMyResult(a.me, a.attemptId, at(s.endAt, 11))).result!;
    const admin = await getAttemptResult(s.admin, a.attemptId);
    expect(admin.result).toMatchObject({ complete: true, maxMarks: mine.maxMarks, obtained: mine.obtained, percentage: mine.percentage, counts: { correct: 1, incorrect: 1, unanswered: 1, evaluated: 2 } });
    expect(admin.questions.map((q) => q.awarded)).toEqual(mine.questions!.map((q) => q.awarded));
    const list = await listAssessmentResults(s.admin, s.assessment.id, at(s.endAt, 11));
    expect(list.candidates.find((c) => c.learner.id === s.learnerA.id)?.best).toMatchObject({ obtained: 12, percentage: 57.14, passed: true });
    expect((await getEvaluation(s.e1, a.attemptId)).attempt.id).toBe(a.attemptId);
    await expect(getEvaluation(s.e2, a.attemptId)).rejects.toThrow();
  });
});

describe("learner detailed result (page)", () => {
  it("renders candidate, assessment, summary and the breakdown — learner text escaped, files with preview/download", async () => {
    const s = await scenario();
    const a = await takeA(s);
    await s.publish();
    const html = await renderPage(a.me, a.attemptId);
    for (const text of [s.learnerA.name, s.learnerA.email, "AI Final Exam", "30 min 0 s", "Submitted", "12 / 21", "57.14%", "Passing marks: 10", "Question-wise breakdown"]) expect(html).toContain(text);
    for (const label of ["Correct", "Incorrect", "Unanswered", "Evaluated", "Partially correct", "Your answer", "Correct answer", "Examiner feedback", "Explanation"]) expect(html).toContain(label);
    expect(html).toContain("Applied &lt;ML&gt;");
    // Learner / examiner text is shown as text, never as markup.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Precise &lt;b&gt;definition&lt;/b&gt;");
    // The file through the protected file route.
    expect(html).toContain("churn.csv");
    expect(html).toContain(`/api/files/${a.fileId}`);
    expect(html).toMatch(/Preview churn\.csv/);
  });

  it("before results are visible: who and when, a pending note — and no marks", async () => {
    const s = await scenario();
    const a = await takeA(s, { finalize: false });
    const html = await renderPage(a.me, a.attemptId);
    expect(html).toContain(s.learnerA.email);
    expect(html).toMatch(/being evaluated/);
    expect(html).not.toContain("Question-wise breakdown");
    expect(html).not.toContain("/ 21");
  });

  it("another learner's attempt is a 404", async () => {
    const s = await scenario();
    const a = await takeA(s);
    const b = await takeB(s);
    await s.publish();
    await expect(renderPage(b.me, a.attemptId)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
