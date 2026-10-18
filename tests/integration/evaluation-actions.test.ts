import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { NotFoundError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment, syncTimeBasedStatuses } from "@/server/services/assessments";
import { startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { listMyEvaluations } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { getAttemptResult, getMyResult, listAssessmentResults, listResultSummaries } from "@/server/services/results";
import { assessmentInput, createReadyPaper, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * Evaluation and results through the server actions the screens use, end to end against
 * assessment_test: submitted attempts → objective scoring → examiner marking (assigned candidates
 * only) → finalize → results ready → publish → the learner's own result.
 */

// --- Next.js request APIs: a cookie jar holding the signed-in user's session ----------------
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
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string, t?: string) => revalidatePath(p, t) }));

const evaluations = await import("@/server/actions/evaluations");
const results = await import("@/server/actions/results");

beforeEach(async () => {
  jar.clear();
  revalidatePath.mockClear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const ok = <T,>(r: { ok: boolean; data?: T; error?: string; fieldErrors?: unknown }) => {
  if (!r.ok) throw new Error(`action failed: ${r.error} ${JSON.stringify(r.fieldErrors ?? {})}`);
  return r.data as T;
};
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const questionsOf = (view: AttemptView) => view.sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "group" ? i.children : [i]))) as ExamQuestion[];

async function staff(role: Role, name: string) {
  const u = await createUser({ role, name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.com` });
  const user: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role };
  return { user, signIn: async () => void jar.set(SESSION_COOKIE_NAME, (await createSession(u.id)).token) };
}

/**
 * A MIXED assessment (MCQ single 2 marks, MCQ multi 2 marks, short answer 5, long answer 10;
 * negative marking 0.5 on the MCQs) taken by three learners: Asha and Bilal are assigned to
 * Examiner One, Chitra to Examiner Two. Asha: single right, multi wrong, short answer written,
 * long answer left blank. Bilal: written answers only. Chitra: objective answers only.
 */
async function world() {
  const admin = await staff(Role.ADMIN, "Admin Person");
  const one = await staff(Role.EXAMINER, "Examiner One");
  const two = await staff(Role.EXAMINER, "Examiner Two");
  const course = await createCourse();
  const paper = await createReadyPaper(admin.user, course.id, {
    sections: [
      {
        title: "Objective",
        questions: [mcqSingle({ text: "Pick the prime" }), mcqSingle({ text: "Pick both", type: "MCQ_MULTI", options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }] })],
      },
      { title: "Written", questions: [shortAnswer({ text: "Define variance." }), shortAnswer({ text: "Discuss bias.", type: "LONG_ANSWER", marks: 10 })] },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 3);
  const members = await db.batchMember.findMany({ where: { batchId: batch.id }, orderBy: { user: { createdAt: "asc" } }, select: { userId: true } });
  for (const [i, m] of members.entries()) await db.user.update({ where: { id: m.userId }, data: { name: ["Asha", "Bilal", "Chitra"][i] } });

  const assessment = await createAssessment(
    admin.user,
    assessmentInput(course.id, { name: "AI Final", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(1), endAt: hoursFromNow(4), passingMarks: 5, resultDetail: "SCORE_AND_ANSWERS" }),
  );
  await publishAssessment(admin.user, assessment.id);
  await assignBatchToAssessment(admin.user, assessment.id, batch.id);
  await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(-1) } });
  await syncTimeBasedStatuses(new Date(), assessment.id);
  const issued = await issueExamCredentials(admin.user, assessment.id);
  const byName = (n: string) => issued.find((i) => i.learner.name === n)!;
  const candidates = await db.assessmentCandidate.findMany({ where: { assessmentId: assessment.id }, select: { id: true, learner: { select: { name: true } } } });
  const candidateOf = (n: string) => candidates.find((c) => c.learner.name === n)!.id;

  // Examiner assignment through the admin action.
  await admin.signIn();
  ok(await results.assignExaminerAction(assessment.id, [candidateOf("Asha"), candidateOf("Bilal")], one.user.id));
  ok(await results.assignExaminerAction(assessment.id, [candidateOf("Chitra")], two.user.id));

  async function learner(name: string) {
    const r = await authenticateExamCredential(byName(name).learner.email, byName(name).code);
    if (!r.ok) throw new Error(r.reason);
    return { user: (await validateSessionToken(r.token))!, token: r.token };
  }
  /** Take and submit the exam with the given answers (by question index). */
  async function take(name: string, answers: (q: ExamQuestion[]) => Record<string, unknown>[]) {
    const { user } = await learner(name);
    const view = await startOrResumeAttempt(user);
    await submitAttempt(user, view.attempt.id, { responses: answers(questionsOf(view)) });
    return { attemptId: view.attempt.id, questions: questionsOf(view) };
  }

  const asha = await take("Asha", ([single, multi, short]) => [
    { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id] }, // "7" — correct
    { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id, multi.options[2].id] }, // wrong
    { assessmentQuestionId: short.assessmentQuestionId, textAnswer: "Spread of values around the mean." },
  ]);
  const bilal = await take("Bilal", ([, , short, long]) => [
    { assessmentQuestionId: short.assessmentQuestionId, textAnswer: "Average squared deviation." },
    { assessmentQuestionId: long.assessmentQuestionId, textAnswer: "Bias is systematic error…" },
  ]);
  const chitra = await take("Chitra", ([single, multi]) => [
    { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id] }, // wrong
    { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id, multi.options[1].id] }, // correct
  ]);
  jar.clear();
  return { admin, one, two, assessment, asha, bilal, chitra, learner };
}

const shortQ = (a: { questions: ExamQuestion[] }) => a.questions[2].assessmentQuestionId;
const longQ = (a: { questions: ExamQuestion[] }) => a.questions[3].assessmentQuestionId;

// ---------------------------------------------------------------------------
describe("objective scoring and evaluation state on submission", () => {
  it("scores objective answers from the frozen snapshot and opens evaluation only where written answers exist", async () => {
    const { admin, asha, bilal, chitra } = await world();

    const a = await getAttemptResult(admin.user, asha.attemptId);
    expect(a.attempt.evaluationStatus).toBe("PENDING");
    expect(a.questions.map((q) => [q.outcome, q.awarded])).toEqual([
      ["correct", 2],
      ["incorrect", -0.5],
      ["pending", null],
      ["unanswered", 0],
    ]);
    expect(a.result).toMatchObject({ maxMarks: 19, obtained: null, provisional: 1.5, objectiveMarks: 1.5, negativeMarks: 0.5, complete: false });

    // Objective answers only: final at once, nothing for an examiner.
    const c = await getAttemptResult(admin.user, chitra.attemptId);
    expect(c.attempt.evaluationStatus).toBe("COMPLETED");
    expect(c.result).toMatchObject({ obtained: 1.5, complete: true, counts: { correct: 1, incorrect: 1, unanswered: 2 } });
    expect((await getAttemptResult(admin.user, bilal.attemptId)).attempt.evaluationStatus).toBe("PENDING");
  });
});

// ---------------------------------------------------------------------------
describe("examiner evaluation", () => {
  it("each examiner sees only their assigned candidates", async () => {
    const { one, two } = await world();
    expect((await listMyEvaluations(one.user)).map((r) => r.learner.name).sort()).toEqual(["Asha", "Bilal"]);
    expect((await listMyEvaluations(two.user)).map((r) => r.learner.name)).toEqual(["Chitra"]);
  });

  it("saves marks and comments for an assigned written answer; a fresh read returns them", async () => {
    const { admin, one, asha } = await world();
    await one.signIn();
    expect(ok(await evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "4", comment: "Good, mention variance formula." }]))).toEqual({ saved: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/examiner", "layout");

    const row = await db.attemptResponse.findFirstOrThrow({ where: { attemptId: asha.attemptId, assessmentQuestionId: shortQ(asha) } });
    expect(row).toMatchObject({ examinerComment: "Good, mention variance formula.", evaluatedById: one.user.id, evaluatedAt: expect.any(Date) });
    expect(row.awardedMarks?.toNumber()).toBe(4);
    const fresh = await getAttemptResult(admin.user, asha.attemptId);
    expect(fresh.attempt.evaluationStatus).toBe("IN_PROGRESS");
    expect(fresh.result).toMatchObject({ obtained: 5.5, provisional: 5.5, complete: true });
  });

  it("refuses marks above the maximum, below zero, on objective or unanswered questions", async () => {
    const { one, asha } = await world();
    await one.signIn();
    const save = (assessmentQuestionId: string, awardedMarks: string) => evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId, awardedMarks }]);
    expect(await save(shortQ(asha), "5.5")).toMatchObject({ ok: false, fieldErrors: { "marks.0.awardedMarks": ["Marks can’t exceed the maximum of 5"] } });
    expect(await save(shortQ(asha), "-1")).toMatchObject({ ok: false, fieldErrors: { "marks.0.awardedMarks": expect.any(Array) } });
    expect(await save(asha.questions[0].assessmentQuestionId, "2")).toMatchObject({ ok: false, fieldErrors: { "marks.0.awardedMarks": ["Only answered written questions are marked by an examiner"] } });
    expect(await save(longQ(asha), "3")).toMatchObject({ ok: false, fieldErrors: { "marks.0.awardedMarks": ["Only answered written questions are marked by an examiner"] } });
    expect(await db.attemptResponse.count({ where: { attemptId: asha.attemptId, awardedMarks: { not: null } } })).toBe(0);
  });

  it("an examiner can't see, mark or finalize another examiner's (or an unassigned) candidate", async () => {
    const { two, asha, assessment } = await world();
    await two.signIn();
    expect(await evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "1" }])).toEqual({ ok: false, error: "Attempt not found." });
    expect(await evaluations.finalizeEvaluationAction(asha.attemptId)).toEqual({ ok: false, error: "Attempt not found." });

    // Unassigning the candidate removes access immediately, even for the old examiner.
    const admin = await staff(Role.ADMIN, "Second Admin");
    await admin.signIn();
    const asCandidate = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: asha.attemptId }, select: { candidateId: true } });
    ok(await results.assignExaminerAction(assessment.id, [asCandidate.candidateId], null));
    const one = await db.user.findFirstOrThrow({ where: { name: "Examiner One" } });
    jar.set(SESSION_COOKIE_NAME, (await createSession(one.id)).token);
    expect(await evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "1" }])).toEqual({ ok: false, error: "Attempt not found." });
    expect(await db.attemptResponse.count({ where: { awardedMarks: { not: null } } })).toBe(0);
  });

  it("finalizing needs every written answer marked, then locks the marks", async () => {
    const { one, bilal } = await world();
    await one.signIn();
    ok(await evaluations.saveEvaluationAction(bilal.attemptId, [{ assessmentQuestionId: shortQ(bilal), awardedMarks: "3" }]));
    expect(await evaluations.finalizeEvaluationAction(bilal.attemptId)).toMatchObject({ ok: false, error: expect.stringMatching(/Enter marks for Q4/) });

    ok(await evaluations.saveEvaluationAction(bilal.attemptId, [{ assessmentQuestionId: longQ(bilal), awardedMarks: "7.5", comment: "Solid." }]));
    ok(await evaluations.finalizeEvaluationAction(bilal.attemptId));
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: bilal.attemptId } })).toMatchObject({ evaluationStatus: "COMPLETED", evaluationFinalizedById: one.user.id, evaluationFinalizedAt: expect.any(Date) });
    expect(await evaluations.saveEvaluationAction(bilal.attemptId, [{ assessmentQuestionId: longQ(bilal), awardedMarks: "10" }])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has been finalized/),
    });
    expect(await evaluations.finalizeEvaluationAction(bilal.attemptId)).toMatchObject({ ok: false });
  });

  it("only examiners use the marking actions", async () => {
    const { admin, asha } = await world();
    await admin.signIn();
    expect(await redirectOf(evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "1" }]))).toBe("/forbidden");
    const reviewer = await staff(Role.REVIEWER, "Rita Reviewer");
    await reviewer.signIn();
    expect(await redirectOf(evaluations.finalizeEvaluationAction(asha.attemptId))).toBe("/forbidden");
    jar.clear();
    expect(await redirectOf(evaluations.finalizeEvaluationAction(asha.attemptId))).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
describe("results", () => {
  /** Asha 4/5 on the short answer; Bilal 3/5 + 7.5/10. */
  async function evaluated() {
    const w = await world();
    await w.one.signIn();
    ok(await evaluations.saveEvaluationAction(w.asha.attemptId, [{ assessmentQuestionId: shortQ(w.asha), awardedMarks: "4", comment: "Good." }]));
    ok(await evaluations.finalizeEvaluationAction(w.asha.attemptId));
    ok(await evaluations.saveEvaluationAction(w.bilal.attemptId, [{ assessmentQuestionId: shortQ(w.bilal), awardedMarks: "3" }, { assessmentQuestionId: longQ(w.bilal), awardedMarks: "7.5" }]));
    return w;
  }

  it("final results combine objective, negative and examiner marks", async () => {
    const { admin, asha, assessment } = await evaluated();
    const a = await getAttemptResult(admin.user, asha.attemptId);
    expect(a.result).toMatchObject({ complete: true, maxMarks: 19, obtained: 5.5, percentage: 28.95, objectiveMarks: 1.5, subjectiveMarks: 4, negativeMarks: 0.5 });

    const list = await listAssessmentResults(admin.user, assessment.id);
    const byName = Object.fromEntries(list.candidates.map((c) => [c.learner.name, c]));
    expect(byName.Asha).toMatchObject({ resultStatus: "FINAL", best: { obtained: 5.5, passed: true }, examiner: { name: "Examiner One" } });
    expect(byName.Bilal).toMatchObject({ resultStatus: "EVALUATION_PENDING", best: null });
    expect(byName.Chitra).toMatchObject({ resultStatus: "FINAL", best: { obtained: 1.5, passed: false }, examiner: { name: "Examiner Two" } });

    const [summary] = await listResultSummaries(admin.user);
    expect(summary).toMatchObject({ id: assessment.id, candidates: 3, attempts: 3, submitted: 3, pendingEvaluation: 1, evaluationCompleted: 2, published: false });
  });

  it("publishes through the lifecycle, refusing moves it doesn't allow", async () => {
    const { admin, one, bilal, assessment } = await evaluated();
    await admin.signIn();
    const move = (to: string) => results.moveAssessmentAction(assessment.id, to);

    expect(await move("PUBLISHED")).toMatchObject({ ok: false, error: "Cannot move from Active to Published manually." });
    expect(await move("DRAFT")).toEqual({ ok: false, error: "This status change isn’t available here." });
    ok(await move("ENDED"));
    ok(await move("EVALUATION"));
    expect(await move("RESULT_READY")).toMatchObject({ ok: false, error: "1 attempt(s) still need evaluation." });

    await one.signIn();
    ok(await evaluations.finalizeEvaluationAction(bilal.attemptId));
    await admin.signIn();
    ok(await move("RESULT_READY"));
    ok(await move("PUBLISHED"));
    expect(revalidatePath).toHaveBeenCalledWith("/learner", "layout");

    const row = await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(row).toMatchObject({ status: "PUBLISHED", publishedAt: expect.any(Date) });
    expect(await move("EVALUATION")).toMatchObject({ ok: false });
    expect(await move("PUBLISHED")).toMatchObject({ ok: false });
    const [summary] = await listResultSummaries(admin.user);
    expect(summary).toMatchObject({ pendingEvaluation: 0, evaluationCompleted: 3, published: true });
  });

  it("reopening an evaluation is possible before results are ready, never after publishing", async () => {
    const { admin, one, asha, bilal, assessment } = await evaluated();
    await admin.signIn();
    expect(await results.reopenEvaluationAction(assessment.id, asha.attemptId, "no")).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(Array) } });
    ok(await results.reopenEvaluationAction(assessment.id, asha.attemptId, "Recheck Q3 marks."));
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: asha.attemptId } })).evaluationStatus).toBe("IN_PROGRESS");

    await one.signIn();
    ok(await evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "5" }]));
    ok(await evaluations.finalizeEvaluationAction(asha.attemptId));
    ok(await evaluations.finalizeEvaluationAction(bilal.attemptId));
    await admin.signIn();
    for (const to of ["ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED"]) ok(await results.moveAssessmentAction(assessment.id, to));
    expect(await results.reopenEvaluationAction(assessment.id, asha.attemptId, "Too late to change.")).toMatchObject({ ok: false, error: expect.stringMatching(/already published/) });
    expect((await getAttemptResult(admin.user, asha.attemptId)).result.obtained).toBe(6.5);
  });

  it("only admins publish, assign examiners or reopen", async () => {
    const { one, asha, assessment, learner } = await world();
    await one.signIn();
    expect(await redirectOf(results.moveAssessmentAction(assessment.id, "ENDED"))).toBe("/forbidden");
    expect(await redirectOf(results.assignExaminerAction(assessment.id, [], one.user.id))).toBe("/forbidden");
    expect(await redirectOf(results.reopenEvaluationAction(assessment.id, asha.attemptId, "Not allowed here"))).toBe("/forbidden");
    jar.set(SESSION_COOKIE_NAME, (await learner("Asha")).token);
    expect(await redirectOf(results.moveAssessmentAction(assessment.id, "ENDED"))).toBe("/forbidden");
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
describe("learner results", () => {
  it("stay hidden until published, then show only the learner's own result", async () => {
    const { admin, one, asha, bilal, assessment, learner } = await world();
    // Sessions opened while the assessment is open (exam sign-in is refused once it has ended).
    const me = (await learner("Asha")).user;
    const bilalSession = (await learner("Bilal")).user;
    expect(await getMyResult(me, asha.attemptId)).toMatchObject({ resultState: "EVALUATION_PENDING", result: null });

    await one.signIn();
    ok(await evaluations.saveEvaluationAction(asha.attemptId, [{ assessmentQuestionId: shortQ(asha), awardedMarks: "4" }]));
    ok(await evaluations.finalizeEvaluationAction(asha.attemptId));
    ok(await evaluations.saveEvaluationAction(bilal.attemptId, [{ assessmentQuestionId: shortQ(bilal), awardedMarks: "3" }, { assessmentQuestionId: longQ(bilal), awardedMarks: "7" }]));
    ok(await evaluations.finalizeEvaluationAction(bilal.attemptId));
    const before = await getMyResult(me, asha.attemptId);
    expect(before).toMatchObject({ resultState: "AWAITING_PUBLICATION", result: null });
    // Nothing about scores or the answer key leaks before publication.
    expect(JSON.stringify(before)).not.toMatch(/obtained|correctOptionIds|isCorrect/);

    await admin.signIn();
    for (const to of ["ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED"]) ok(await results.moveAssessmentAction(assessment.id, to));

    const after = await getMyResult(me, asha.attemptId);
    expect(after).toMatchObject({ resultState: "AVAILABLE", result: { obtained: 5.5, maxMarks: 19, percentage: 28.95, passed: true } });
    expect(after.result!.questions![0]).toMatchObject({ outcome: "correct", awarded: 2, correctOptionIds: [asha.questions[0].options[1].id] });

    // Another learner's attempt id is "not found", for their own session too.
    await expect(getMyResult(bilalSession, asha.attemptId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyResult(me, bilal.attemptId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getMyResult(bilalSession, bilal.attemptId)).toMatchObject({ resultState: "AVAILABLE", result: { obtained: 10 } });
  });

  it("after publication the exam password signs the learner in again to see results only", async () => {
    const { admin, one, asha, bilal, assessment, learner } = await world();
    // Before publication, once the assessment has ended, sign-in is refused.
    await admin.signIn();
    ok(await results.moveAssessmentAction(assessment.id, "ENDED"));
    await expect(learner("Asha")).rejects.toThrow(/expired|assessment_unavailable/);

    await one.signIn();
    for (const a of [asha, bilal]) {
      const marks = a === asha ? [{ assessmentQuestionId: shortQ(a), awardedMarks: "4" }] : [{ assessmentQuestionId: shortQ(a), awardedMarks: "3" }, { assessmentQuestionId: longQ(a), awardedMarks: "7" }];
      ok(await evaluations.saveEvaluationAction(a.attemptId, marks));
      ok(await evaluations.finalizeEvaluationAction(a.attemptId));
    }
    await admin.signIn();
    for (const to of ["EVALUATION", "RESULT_READY", "PUBLISHED"]) ok(await results.moveAssessmentAction(assessment.id, to));

    const me = (await learner("Asha")).user;
    expect(me.assessmentId).toBe(assessment.id);
    expect(await getMyResult(me, asha.attemptId)).toMatchObject({ resultState: "AVAILABLE", result: { obtained: 5.5 } });
    await expect(startOrResumeAttempt(me)).rejects.toThrow(/isn’t open|already taken/);
    expect(await db.auditLog.count({ where: { action: "auth.exam_login_succeeded", metadata: { path: ["resultsOnly"], equals: true } } })).toBe(1);
  });
});
