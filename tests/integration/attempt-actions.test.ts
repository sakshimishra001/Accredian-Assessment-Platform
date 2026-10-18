import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptStatus, Role } from "@/generated/prisma/enums";
import { EXAM_LOGIN_ERRORS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment, syncTimeBasedStatuses } from "@/server/services/assessments";
import type { AttemptView, ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, removeCandidate } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { updateQuestion } from "@/server/services/questions";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * The learner exam flow through its server actions, end to end against assessment_test: exam
 * sign-in (cookie session scoped to one assessment), start/resume, autosave, submit — with the
 * attempt service, PostgreSQL and the real clock.
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

const { examLoginAction } = await import("@/server/auth/actions");
const attempts = await import("@/server/actions/attempts");
const { getMyAttempt, getMyExamOverview } = await import("@/server/services/attempts");
const { validateSessionToken } = await import("@/server/auth/session");

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
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const questionsOf = (view: AttemptView) => view.sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "group" ? i.children : [i]))) as ExamQuestion[];

/**
 * A published MIXED assessment that is open right now (its window moved to started an hour ago,
 * as the clock would), for a batch of two learners with freshly issued exam passwords.
 */
async function openExam(opts: { name?: string; course?: { id: string }; maxAttempts?: number } = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = opts.course ?? (await createCourse());
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        title: "Section A — Objective",
        questions: [mcqSingle({ text: "Single" }), mcqSingle({ text: "Multi", type: "MCQ_MULTI", options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }] })],
      },
      { title: "Section B — Written", questions: [shortAnswer({ text: "Explain overfitting." })] },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 2);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { name: opts.name ?? "AI Final Exam", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(1), endAt: hoursFromNow(4), durationMinutes: 60, maxAttempts: opts.maxAttempts ?? 1 }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  // The clock reaches the start time: open it now (the server's own SCHEDULED → ACTIVE move).
  await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(-1) } });
  await syncTimeBasedStatuses(new Date(), assessment.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const learners = issued.map((i) => ({ ...i.learner, code: i.code })).sort((a, b) => a.name.localeCompare(b.name));
  return { admin, course, paper, assessment, learners };
}

/** Sign in through the real exam login action; the session cookie lands in the jar. */
async function examLogin(email: string, code: string) {
  jar.clear();
  return redirectOf(examLoginAction(null, form({ email, code })));
}

// ---------------------------------------------------------------------------
describe("exam sign-in", () => {
  it("a valid email + exam password opens a session scoped to that one assessment", async () => {
    const { assessment, learners } = await openExam();
    expect(await examLogin(learners[0].email.toUpperCase(), learners[0].code.toLowerCase())).toBe("/learner");
    const user = await validateSessionToken(jar.get(SESSION_COOKIE_NAME));
    expect(user).toMatchObject({ id: learners[0].id, role: "LEARNER", assessmentId: assessment.id, examCredentialId: expect.any(String) });
    // The cookie holds an opaque token — never the exam password or its hash.
    const cred = await db.examCredential.findUniqueOrThrow({ where: { id: user!.examCredentialId! } });
    expect(jar.get(SESSION_COOKIE_NAME)).not.toContain(learners[0].code);
    expect(jar.get(SESSION_COOKIE_NAME)).not.toBe(cred.codeHash);
  });

  it("rejects a wrong password, another learner's password and an unknown email", async () => {
    const { learners } = await openExam();
    const [a, b] = learners;
    for (const [email, code] of [
      [a.email, "WRONG1"],
      [a.email, b.code],
      ["nobody@example.com", a.code],
    ]) {
      jar.clear();
      expect(await examLoginAction(null, form({ email, code }))).toEqual({ ok: false, error: EXAM_LOGIN_ERRORS.invalid_credentials });
      expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    }
  });

  it("a password only opens its own assessment, never another one of the same learner", async () => {
    const first = await openExam({ name: "First exam" });
    const learner = first.learners[0];
    const second = await openExam({ name: "Second exam", course: first.course });
    // Make the same learner a candidate of the second exam too, with a different password.
    await db.assessmentCandidate.create({ data: { assessmentId: second.assessment.id, learnerId: learner.id } });
    const [secondCode] = (await issueExamCredentials(second.admin, second.assessment.id)).filter((c) => c.learner.id === learner.id);

    await examLogin(learner.email, learner.code);
    expect((await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!.assessmentId).toBe(first.assessment.id);
    const firstView = await getMyExamOverview((await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!);
    expect(firstView.assessment.id).toBe(first.assessment.id);

    await examLogin(learner.email, secondCode.code);
    expect((await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!.assessmentId).toBe(second.assessment.id);
  });
});

// ---------------------------------------------------------------------------
describe("eligibility and start", () => {
  it("starts an attempt with the frozen content and no answer key; a repeated start resumes it", async () => {
    const { assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);

    const { attemptId } = ok(await attempts.startAttemptAction(assessment.id));
    const again = ok(await attempts.startAttemptAction(assessment.id));
    expect(again.attemptId).toBe(attemptId);
    expect(await db.assessmentAttempt.count()).toBe(1);
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "IN_PROGRESS", attemptNumber: 1, learnerId: learners[0].id, assessmentId: assessment.id });

    const user = (await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!;
    const view = await getMyAttempt(user, attemptId);
    expect(view.attempt.remainingSeconds).toBeGreaterThan(55 * 60);
    expect(JSON.stringify(view)).not.toMatch(/isCorrect|guidance|correct/);
    expect(questionsOf(view).map((q) => q.text)).toEqual(["Single", "Multi", "Explain overfitting."]);
  });

  it("concurrent starts create exactly one attempt", async () => {
    const { assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);
    const results = await Promise.all([attempts.startAttemptAction(assessment.id), attempts.startAttemptAction(assessment.id), attempts.startAttemptAction(assessment.id)]);
    expect(new Set(results.map((r) => ok(r).attemptId)).size).toBe(1);
    expect(await db.assessmentAttempt.count()).toBe(1);
  });

  it("an unassigned learner has no exam session and can't start", async () => {
    const { admin, assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);
    const candidate = await db.assessmentCandidate.findFirstOrThrow({ where: { assessmentId: assessment.id, learnerId: learners[0].id } });
    await removeCandidate(admin, assessment.id, candidate.id);
    // Removing the candidate removes their exam password and ends the session it opened.
    expect(await redirectOf(attempts.startAttemptAction(assessment.id))).toBe("/login");
    expect(await db.assessmentAttempt.count()).toBe(0);
  });

  it("refuses to start outside the window and after the attempt limit", async () => {
    const { assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);
    // Not yet open (a session from a password that is valid now, but the assessment starts later).
    await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(2), status: "SCHEDULED" } });
    expect(await attempts.startAttemptAction(assessment.id)).toEqual({ ok: false, error: "This assessment isn’t open right now." });
    // Already closed.
    await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(-3), endAt: hoursFromNow(-1), status: "ENDED" } });
    expect(await attempts.startAttemptAction(assessment.id)).toEqual({ ok: false, error: "This assessment isn’t open right now." });
    expect(await db.assessmentAttempt.count()).toBe(0);

    // Open again, one attempt allowed: a second one is refused once the first is submitted.
    await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(-1), endAt: hoursFromNow(3), status: "ACTIVE" } });
    const { attemptId } = ok(await attempts.startAttemptAction(assessment.id));
    ok(await attempts.submitAttemptAction(attemptId));
    expect(await attempts.startAttemptAction(assessment.id)).toEqual({ ok: false, error: "You have already taken this assessment." });
    expect(await db.assessmentAttempt.count()).toBe(1);
  });

  it("staff sessions can't use the learner exam actions", async () => {
    const { assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);
    const { attemptId } = ok(await attempts.startAttemptAction(assessment.id));
    for (const role of [Role.ADMIN, Role.EXAMINER, Role.REVIEWER]) {
      const u = await createUser({ role, email: `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com` });
      jar.set(SESSION_COOKIE_NAME, (await createSession(u.id)).token);
      expect(await redirectOf(attempts.startAttemptAction(assessment.id))).toBe("/forbidden");
      expect(await redirectOf(attempts.saveResponsesAction(attemptId, []))).toBe("/forbidden");
      expect(await redirectOf(attempts.submitAttemptAction(attemptId))).toBe("/forbidden");
    }
    jar.clear();
    expect(await redirectOf(attempts.submitAttemptAction(attemptId))).toBe("/login");
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
describe("answers and autosave", () => {
  async function started() {
    const exam = await openExam();
    await examLogin(exam.learners[0].email, exam.learners[0].code);
    const { attemptId } = ok(await attempts.startAttemptAction(exam.assessment.id));
    const user = (await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!;
    const view = await getMyAttempt(user, attemptId);
    const [single, multi, written] = questionsOf(view);
    return { ...exam, attemptId, user, single, multi, written };
  }

  it("saves, updates and restores answers of every type on the right attempt", async () => {
    const { attemptId, user, single, multi, written } = await started();
    const r = ok(
      await attempts.saveResponsesAction(attemptId, [
        { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id], clientSeq: 1 },
        { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id, multi.options[2].id], markedForReview: true, clientSeq: 1 },
        { assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Fitting noise.", clientSeq: 1 },
      ]),
    );
    expect(r).toMatchObject({ saved: 3, ignored: 0, remainingSeconds: expect.any(Number) });

    // Change one answer, clear another (Clear response), unmark review.
    ok(
      await attempts.saveResponsesAction(attemptId, [
        { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id], clientSeq: 2 },
        { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [], markedForReview: false, clientSeq: 2 },
      ]),
    );

    // A fresh read (as after a browser refresh) returns exactly what was saved, with the sequence to continue from.
    const view = await getMyAttempt(user, attemptId);
    const byQ = Object.fromEntries(view.responses.map((x) => [x.assessmentQuestionId, x]));
    expect(byQ[single.assessmentQuestionId]).toMatchObject({ selectedOptionIds: [single.options[0].id], clientSeq: 2 });
    expect(byQ[multi.assessmentQuestionId]).toMatchObject({ selectedOptionIds: [], markedForReview: false, clientSeq: 2 });
    expect(byQ[written.assessmentQuestionId]).toMatchObject({ textAnswer: "Fitting noise.", clientSeq: 1 });
    const rows = await db.attemptResponse.findMany({ where: { attemptId } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((x) => x.attemptId))).toEqual(new Set([attemptId]));
  });

  it("repeated and out-of-order autosaves are safe", async () => {
    const { attemptId, single } = await started();
    const save = (seq: number, option: number) => attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[option].id], clientSeq: seq }]);
    ok(await save(5, 1));
    expect(ok(await save(5, 1))).toMatchObject({ saved: 0, ignored: 1 });
    expect(ok(await save(4, 0))).toMatchObject({ saved: 0, ignored: 1 });
    expect(await db.attemptResponse.findFirstOrThrow({ where: { attemptId } })).toMatchObject({ selectedOptionIds: [single.options[1].id], clientSeq: 5 });
    expect(await db.attemptResponse.count()).toBe(1);
  });

  it("validates answers against the question snapshot", async () => {
    const { attemptId, single, written } = await started();
    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id, single.options[1].id] }])).toMatchObject({ ok: false });
    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: written.assessmentQuestionId, selectedOptionIds: ["made-up"] }])).toMatchObject({ ok: false });
    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: "not-in-this-assessment", selectedOptionIds: [] }])).toMatchObject({ ok: false });
    expect(await db.attemptResponse.count()).toBe(0);
  });

  it("keeps the content the attempt started with when the bank question is edited later", async () => {
    const { admin, paper, attemptId, user, single } = await started();
    await updateQuestion(admin, paper.questionIds[0], mcqSingle({ text: "Single (edited in the bank)" }));
    const view = await getMyAttempt(user, attemptId);
    const q = questionsOf(view).find((x) => x.assessmentQuestionId === single.assessmentQuestionId)!;
    expect(q.text).toBe("Single");
    expect(q.options.map((o) => o.id)).toEqual(single.options.map((o) => o.id));
  });

  it("a learner can't read, save to or submit another learner's attempt", async () => {
    const { learners, attemptId, single } = await started();
    await examLogin(learners[1].email, learners[1].code);
    const other = (await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!;
    await expect(getMyAttempt(other, attemptId)).rejects.toThrow("Attempt not found.");
    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id] }])).toEqual({ ok: false, error: "Attempt not found." });
    expect(await attempts.submitAttemptAction(attemptId)).toEqual({ ok: false, error: "Attempt not found." });
    expect(await db.attemptResponse.count()).toBe(0);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).status).toBe("IN_PROGRESS");
  });

  it("an expired attempt accepts no new answers and is closed with what was saved in time", async () => {
    const { attemptId, single, written } = await started();
    ok(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "In time", clientSeq: 1 }]));
    // Two hours later (duration is 60 minutes).
    await db.assessmentAttempt.update({ where: { id: attemptId }, data: { startedAt: hoursFromNow(-2), deadlineAt: hoursFromNow(-1) } });

    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id], clientSeq: 1 }])).toEqual({
      ok: false,
      error: "Time is up. Your saved answers were submitted automatically.",
    });
    const row = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { responses: true } });
    expect(row.status).toBe(AttemptStatus.AUTO_SUBMITTED);
    expect(row.responses.map((r) => r.textAnswer)).toEqual(["In time"]);
  });
});

// ---------------------------------------------------------------------------
describe("submission", () => {
  it("submits with the last unsaved answers; repeating it changes nothing and nothing can be saved after", async () => {
    const { assessment, learners } = await openExam();
    await examLogin(learners[0].email, learners[0].code);
    const { attemptId } = ok(await attempts.startAttemptAction(assessment.id));
    const user = (await validateSessionToken(jar.get(SESSION_COOKIE_NAME)))!;
    const [single, , written] = questionsOf(await getMyAttempt(user, attemptId));
    ok(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id], clientSeq: 1 }]));

    const first = ok(await attempts.submitAttemptAction(attemptId, [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Final answer", clientSeq: 1 }]));
    expect(first).toEqual({ status: "SUBMITTED", savedResponses: 2, alreadySubmitted: false, lateAnswersIgnored: false });
    expect(revalidatePath).toHaveBeenCalledWith("/learner", "layout");

    const again = ok(await attempts.submitAttemptAction(attemptId, [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Changed later", clientSeq: 2 }]));
    expect(again).toMatchObject({ status: "SUBMITTED", alreadySubmitted: true, savedResponses: 2 });
    expect(await attempts.saveResponsesAction(attemptId, [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Too late", clientSeq: 3 }])).toEqual({
      ok: false,
      error: "This attempt has already been submitted. Answers can no longer be changed.",
    });

    // A fresh read: the attempt and its answers are persisted exactly as submitted.
    const row = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { responses: { orderBy: { createdAt: "asc" } } } });
    expect(row).toMatchObject({ status: "SUBMITTED", submittedAt: expect.any(Date), learnerId: learners[0].id });
    expect(row.responses.map((r) => [r.selectedOptionIds, r.textAnswer])).toEqual([
      [[single.options[1].id], null],
      [[], "Final answer"],
    ]);
    const overview = await getMyExamOverview(user);
    expect(overview).toMatchObject({ inProgressAttemptId: null, canStart: false, attemptsLeft: 0, attempts: [{ id: attemptId, status: "SUBMITTED", savedResponses: 2 }] });
  });
});
