import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment, transitionAssessment, updateAssessment } from "@/server/services/assessments";
import {
  closeExpiredAttempts,
  getAttemptForAdmin,
  getMyAttempt,
  getMyExamOverview,
  listAttempts,
  saveResponses,
  startOrResumeAttempt,
  submitAttempt,
  type AttemptView,
  type ExamQuestion,
} from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { addPaperGroup, addPaperQuestion, addSection, createQuestionPaper } from "@/server/services/question-papers";
import { issueExamCredentials, revokeExamCredential } from "@/server/services/exam-credentials";
import { setLearnerStatus } from "@/server/services/learners";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const expectError = (p: Promise<unknown>, type: new (...args: never[]) => Error) => expect(p).rejects.toBeInstanceOf(type);
const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

/**
 * A published MIXED assessment open from +1h to +4h (60-minute duration) for a batch of two
 * learners, with exam passwords issued. T0 is a moment inside the window.
 */
async function scenario(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      { title: "Section A — Objective", questions: [mcqSingle({ text: "Single" }), mcqSingle({ text: "Multi", type: "MCQ_MULTI", options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }] })] },
      { title: "Section B — Written", questions: [shortAnswer({ text: "Explain overfitting." })] },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { name: "AI Final Exam", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt, durationMinutes: 60, ...settings }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const T0 = at(startAt, 15);
  const learners = issued.map((i) => i.learner).sort((a, b) => a.name.localeCompare(b.name));
  const codeOf = (email: string) => issued.find((i) => i.learner.email === email)!.code;

  /** Sign in like the exam screen does and return the session user (scoped to this assessment). */
  async function examLogin(email: string, now = T0): Promise<SessionUser> {
    const r = await authenticateExamCredential(email, codeOf(email), {}, now);
    if (!r.ok) throw new Error(`exam login failed: ${r.reason}`);
    return (await validateSessionToken(r.token, now))!;
  }
  const [a, b] = learners;
  return { admin, course, paper, batch, assessment, startAt, endAt, T0, issued, examLogin, rahul: a, priya: b };
}

const questionsOf = (view: AttemptView) => view.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");

// ---------------------------------------------------------------------------
describe("start", () => {
  it("an eligible learner starts an attempt with the exact content, deadline and no answer key", async () => {
    const { examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);

    const view = await startOrResumeAttempt(me, T0);

    expect(view.attempt).toMatchObject({ attemptNumber: 1, status: "IN_PROGRESS", remainingSeconds: 3600 });
    expect(view.attempt.deadlineAt).toEqual(at(T0, 60));
    expect(view.assessment).toMatchObject({ id: assessment.id, name: "AI Final Exam", maxAttempts: 1 });
    expect(view.sections.map((s) => [s.title, s.items.length])).toEqual([
      ["Section A — Objective", 2],
      ["Section B — Written", 1],
    ]);
    expect(questionsOf(view).map((q) => [q.number, q.type, q.text])).toEqual([
      ["1", "MCQ_SINGLE", "Single"],
      ["2", "MCQ_MULTI", "Multi"],
      ["3", "SHORT_ANSWER", "Explain overfitting."],
    ]);
    const json = JSON.stringify(view);
    expect(json).not.toContain("isCorrect");
    expect(json).not.toContain("guidance");
    expect(await db.auditLog.count({ where: { action: AuditAction.ATTEMPT_STARTED } })).toBe(1);
  });

  it("delivers a case study as one item: passage first, then its sub-questions", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createQuestionPaper(admin, { name: "Case paper", courseId: course.id });
    const s1 = await addSection(admin, paper.id, { title: "Section A" });
    await addPaperQuestion(admin, s1.id, shortAnswer({ text: "Warm-up" }));
    const s2 = await addSection(admin, paper.id, { title: "Section B — Case", attemptRule: "ALL" });
    const group = await addPaperGroup(admin, s2.id, { groupType: "CASE_STUDY", text: "Airline delays", passage: "An airline wants to cut delays…" });
    await addPaperQuestion(admin, s2.id, shortAnswer({ text: "Core problem?" }), { parentId: group.id });
    await addPaperQuestion(admin, s2.id, shortAnswer({ text: "Your plan?" }), { parentId: group.id });
    const batch = await createBatchWithLearners(course.id, 1);
    const startAt = hoursFromNow(1);
    const assessment = await createAssessment(admin, assessmentInput(course.id, { type: "SUBJECTIVE", paperId: paper.id, batchId: batch.id, startAt, endAt: hoursFromNow(3) }));
    await publishAssessment(admin, assessment.id);
    await assignBatchToAssessment(admin, assessment.id, batch.id);
    const [cred] = await issueExamCredentials(admin, assessment.id);
    const login = await authenticateExamCredential(cred.learner.email, cred.code, {}, at(startAt, 5));
    if (!login.ok) throw new Error(login.reason);

    const view = await startOrResumeAttempt((await validateSessionToken(login.token, at(startAt, 5)))!, at(startAt, 5));

    expect(view.sections[1].items).toEqual([
      expect.objectContaining({
        kind: "group",
        number: "2",
        groupType: "CASE_STUDY",
        text: "Airline delays",
        passage: "An airline wants to cut delays…",
        children: [expect.objectContaining({ number: "2(a)", text: "Core problem?" }), expect.objectContaining({ number: "2(b)", text: "Your plan?" })],
      }),
    ]);
  });

  it("refuses a learner who isn't assigned (candidate) to the assessment", async () => {
    const { examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);
    await db.examCredential.deleteMany({ where: { candidate: { learnerId: rahul.id } } });
    await db.assessmentCandidate.deleteMany({ where: { learnerId: rahul.id } });
    // A forged/stale session object for this assessment is still refused by the service.
    await expect(startOrResumeAttempt({ ...me, assessmentId: assessment.id }, T0)).rejects.toThrow(/not assigned/);
  });

  it("refuses a revoked or expired credential", async () => {
    const { admin, examLogin, rahul, priya, T0, assessment, issued } = await scenario();
    const me = await examLogin(rahul.email);
    await revokeExamCredential(admin, issued.find((i) => i.learner.id === rahul.id)!.credentialId);
    await expect(startOrResumeAttempt(me, T0)).rejects.toThrow(/exam password isn’t valid/);

    const priyaCandidate = issued.find((i) => i.learner.id === priya.id)!.candidateId;
    await issueExamCredentials(admin, assessment.id, { candidateIds: [priyaCandidate], window: { validUntil: at(T0, 10) } });
    const reissued = await db.examCredential.findFirstOrThrow({ where: { candidateId: priyaCandidate, status: "ACTIVE" } });
    const priyaSession: SessionUser = { id: priya.id, email: priya.email, name: priya.name, role: Role.LEARNER, assessmentId: assessment.id, examCredentialId: reissued.id };
    await expect(startOrResumeAttempt(priyaSession, at(T0, 20))).rejects.toThrow(/exam password isn’t valid/);
    expect(await db.assessmentAttempt.count()).toBe(0);
  });

  it("refuses a disabled learner", async () => {
    const { admin, examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    await setLearnerStatus(admin, rahul.id, UserStatus.DISABLED);
    await expect(startOrResumeAttempt(me, T0)).rejects.toThrow(/disabled/);
  });

  it("refuses when the assessment isn't open by the server clock", async () => {
    const { examLogin, rahul, startAt, endAt } = await scenario();
    const me = await examLogin(rahul.email);
    await expect(startOrResumeAttempt(me, at(startAt, -10))).rejects.toThrow(/isn’t open/);
    await expect(startOrResumeAttempt(me, at(endAt, 1))).rejects.toThrow(/isn’t open/);
  });

  it("enforces one attempt by default and a configured limit", async () => {
    const one = await scenario();
    const me = await one.examLogin(one.rahul.email);
    const first = await startOrResumeAttempt(me, one.T0);
    await submitAttempt(me, first.attempt.id, {}, at(one.T0, 5));
    await expect(startOrResumeAttempt(me, at(one.T0, 6))).rejects.toThrow(/already taken this assessment/);

    await resetDatabase();
    const two = await scenario({ maxAttempts: 2 });
    const me2 = await two.examLogin(two.rahul.email);
    const a1 = await startOrResumeAttempt(me2, two.T0);
    await submitAttempt(me2, a1.attempt.id, {}, at(two.T0, 1));
    const a2 = await startOrResumeAttempt(me2, at(two.T0, 2));
    expect(a2.attempt).toMatchObject({ attemptNumber: 2, status: "IN_PROGRESS" });
    await submitAttempt(me2, a2.attempt.id, {}, at(two.T0, 3));
    await expect(startOrResumeAttempt(me2, at(two.T0, 4))).rejects.toThrow(/used all 2 attempts/);
  });

  it("a repeated start returns the same in-progress attempt", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const a = await startOrResumeAttempt(me, T0);
    const b = await startOrResumeAttempt(me, at(T0, 1));
    expect(b.attempt.id).toBe(a.attempt.id);
    expect(await db.assessmentAttempt.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("responses", () => {
  async function started() {
    const s = await scenario();
    const me = await s.examLogin(s.rahul.email);
    const view = await startOrResumeAttempt(me, s.T0);
    const [single, multi, written] = questionsOf(view);
    return { ...s, me, view, single, multi, written };
  }

  it("saves, updates and restores answers; repeating a save is a no-op", async () => {
    const { me, view, single, multi, written, T0 } = await started();
    const id = view.attempt.id;
    await saveResponses(me, id, { responses: [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[0].id] }] }, at(T0, 1));
    await saveResponses(me, id, { responses: [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id], markedForReview: true }] }, at(T0, 2));
    const payload = {
      responses: [
        { assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id, multi.options[2].id] },
        { assessmentQuestionId: written.assessmentQuestionId, textAnswer: "When a model memorises noise." },
      ],
    };
    const first = await saveResponses(me, id, payload, at(T0, 3));
    const again = await saveResponses(me, id, payload, at(T0, 3));
    expect(first).toMatchObject({ saved: 2, ignored: 0, remainingSeconds: 57 * 60 });
    expect(again.saved).toBe(2);

    const reloaded = await getMyAttempt(me, id, at(T0, 4));
    const byQ = new Map(reloaded.responses.map((r) => [r.assessmentQuestionId, r]));
    expect(byQ.get(single.assessmentQuestionId)).toMatchObject({ selectedOptionIds: [single.options[1].id], markedForReview: true });
    expect(byQ.get(multi.assessmentQuestionId)?.selectedOptionIds).toEqual([multi.options[0].id, multi.options[2].id]);
    expect(byQ.get(written.assessmentQuestionId)?.textAnswer).toBe("When a model memorises noise.");
    expect(await db.attemptResponse.count()).toBe(3);
  });

  it("ignores an out-of-order (older) autosave", async () => {
    const { me, view, written, T0 } = await started();
    const save = (text: string, clientSeq: number) =>
      saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: text, clientSeq }] }, at(T0, 1));
    await save("Newest", 5);
    expect(await save("Older", 3)).toMatchObject({ saved: 0, ignored: 1 });
    expect((await db.attemptResponse.findFirstOrThrow()).textAnswer).toBe("Newest");
  });

  it("validates answers against the question snapshot", async () => {
    const { me, view, single, multi, written, T0, admin, course } = await started();
    const bad = async (r: Record<string, unknown>) => expectError(saveResponses(me, view.attempt.id, { responses: [r] }, at(T0, 1)), ValidationError);
    await bad({ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: ["not-an-option"] });
    await bad({ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: single.options.map((o) => o.id) });
    await bad({ assessmentQuestionId: single.assessmentQuestionId, textAnswer: "typed instead" });
    await bad({ assessmentQuestionId: multi.assessmentQuestionId, selectedOptionIds: [multi.options[0].id, multi.options[0].id] });
    await bad({ assessmentQuestionId: written.assessmentQuestionId, selectedOptionIds: [single.options[0].id] });
    // A question of a different assessment.
    const otherPaper = await createReadyPaper(admin, course.id, { name: "Other" });
    const otherBatch = await createBatchWithLearners(course.id, 1);
    const other = await createAssessment(admin, assessmentInput(course.id, { name: "Other exam", paperId: otherPaper.id, batchId: otherBatch.id }));
    const foreignQ = await db.assessmentQuestion.findFirstOrThrow({ where: { assessmentId: other.id } });
    await bad({ assessmentQuestionId: foreignQ.id, selectedOptionIds: [] });
    expect(await db.attemptResponse.count()).toBe(0);
  });

  it("the database rejects a response pointing at another assessment's question", async () => {
    const { view, admin, course } = await started();
    const otherPaper = await createReadyPaper(admin, course.id, { name: "Other" });
    const other = await createAssessment(admin, assessmentInput(course.id, { name: "Other exam", paperId: otherPaper.id }));
    const foreignQ = await db.assessmentQuestion.findFirstOrThrow({ where: { assessmentId: other.id } });
    const attempt = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: view.attempt.id } });
    await expect(
      db.attemptResponse.create({ data: { attemptId: attempt.id, assessmentId: attempt.assessmentId, assessmentQuestionId: foreignQ.id } }),
    ).rejects.toThrow();
  });

  it("can't be changed after submission or after the deadline", async () => {
    const s = await started();
    await submitAttempt(s.me, s.view.attempt.id, {}, at(s.T0, 5));
    await expect(saveResponses(s.me, s.view.attempt.id, { responses: [{ assessmentQuestionId: s.single.assessmentQuestionId, selectedOptionIds: [] }] }, at(s.T0, 6))).rejects.toThrow(/already been submitted/);

    const p = await s.examLogin(s.priya.email);
    const pv = await startOrResumeAttempt(p, s.T0);
    await saveResponses(p, pv.attempt.id, { responses: [{ assessmentQuestionId: s.written.assessmentQuestionId, textAnswer: "Saved in time" }] }, at(s.T0, 30));
    await expect(saveResponses(p, pv.attempt.id, { responses: [{ assessmentQuestionId: s.written.assessmentQuestionId, textAnswer: "Too late" }] }, at(s.T0, 61))).rejects.toThrow(/Time is up/);
    const closed = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: pv.attempt.id }, include: { responses: true } });
    expect(closed).toMatchObject({ status: "AUTO_SUBMITTED", submittedAt: at(s.T0, 60) });
    expect(closed.responses.map((r) => r.textAnswer)).toEqual(["Saved in time"]);
  });
});

// ---------------------------------------------------------------------------
describe("learner overview", () => {
  it("describes the assessment without question content, and tracks the learner's own attempts", async () => {
    const { examLogin, rahul, startAt, T0 } = await scenario();
    const me = await examLogin(rahul.email);

    const before = await getMyExamOverview(me, at(startAt, -30));
    expect(before).toMatchObject({ open: false, canStart: false, attempts: [], inProgressAttemptId: null, attemptsLeft: 1 });
    expect(before.sections.map((s) => [s.title, s.questionCount])).toEqual([
      ["Section A — Objective", 2],
      ["Section B — Written", 1],
    ]);
    // Titles and counts only: no question text, options or answers.
    expect(JSON.stringify(before)).not.toMatch(/Explain overfitting|isCorrect|options/);

    expect(await getMyExamOverview(me, T0)).toMatchObject({ open: true, canStart: true });
    const view = await startOrResumeAttempt(me, T0);
    expect(await getMyExamOverview(me, at(T0, 5))).toMatchObject({ canStart: false, inProgressAttemptId: view.attempt.id, attempts: [{ status: "IN_PROGRESS" }] });

    // Past the deadline, the overview closes the attempt before reporting it.
    expect(await getMyExamOverview(me, at(T0, 61))).toMatchObject({ inProgressAttemptId: null, attemptsLeft: 0, canStart: false, attempts: [{ id: view.attempt.id, status: "AUTO_SUBMITTED" }] });
  });

  it("is only for a learner exam session", async () => {
    const { admin } = await scenario();
    await expectError(getMyExamOverview(admin), ForbiddenError);
  });
});

describe("resume", () => {
  it("returns the same attempt with saved answers and the remaining time after a reload", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const q = questionsOf(view)[2];
    await saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: q.assessmentQuestionId, textAnswer: "Draft answer" }] }, at(T0, 10));

    // A fresh sign-in (e.g. after closing the browser) resumes rather than starting again.
    const again = await examLogin(rahul.email, at(T0, 20));
    const resumed = await startOrResumeAttempt(again, at(T0, 20));
    expect(resumed.attempt).toMatchObject({ id: view.attempt.id, remainingSeconds: 40 * 60 });
    expect(resumed.responses).toEqual([expect.objectContaining({ assessmentQuestionId: q.assessmentQuestionId, textAnswer: "Draft answer" })]);
    expect(await db.assessmentAttempt.count()).toBe(1);
  });

  it("when resume is turned off, only the session that started the attempt may continue", async () => {
    const { examLogin, rahul, T0 } = await scenario({ allowResume: false });
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    await expect(startOrResumeAttempt(me, at(T0, 1))).resolves.toMatchObject({ attempt: { id: view.attempt.id } }); // page refresh
    const newSignIn = await examLogin(rahul.email, at(T0, 2));
    await expect(startOrResumeAttempt(newSignIn, at(T0, 2))).rejects.toThrow(/doesn’t allow resuming/);
  });
});

// ---------------------------------------------------------------------------
describe("timer and deadline", () => {
  it("remaining time comes from server timestamps, not the client", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    expect((await getMyAttempt(me, view.attempt.id, at(T0, 25.5))).attempt.remainingSeconds).toBe(34 * 60 + 30);
    expect((await getMyAttempt(me, view.attempt.id, at(T0, 59))).attempt.status).toBe("IN_PROGRESS");
  });

  it("detects an expired attempt on the next request and closes it", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const later = await getMyAttempt(me, view.attempt.id, at(T0, 75));
    expect(later.attempt).toMatchObject({ status: "AUTO_SUBMITTED", remainingSeconds: 0, submittedAt: at(T0, 60) });
    expect(await db.auditLog.count({ where: { action: AuditAction.ATTEMPT_AUTO_SUBMITTED } })).toBe(1);
  });

  it("WINDOW mode caps the deadline at the window end; FULL_DURATION gives the full time", async () => {
    const win = await scenario();
    const late = at(win.endAt, -20);
    const me = await win.examLogin(win.rahul.email, late);
    expect((await startOrResumeAttempt(me, late)).attempt).toMatchObject({ deadlineAt: win.endAt, remainingSeconds: 20 * 60 });

    await resetDatabase();
    const full = await scenario({ timingMode: "FULL_DURATION" });
    const lateFull = at(full.endAt, -20);
    const me2 = await full.examLogin(full.rahul.email, lateFull);
    const v = await startOrResumeAttempt(me2, lateFull);
    expect(v.attempt.deadlineAt).toEqual(at(lateFull, 60));
    // Still answering after the window has closed.
    const q = questionsOf(v)[2];
    await expect(saveResponses(me2, v.attempt.id, { responses: [{ assessmentQuestionId: q.assessmentQuestionId, textAnswer: "After window" }] }, at(full.endAt, 10))).resolves.toMatchObject({ saved: 1 });
  });

  it("ending the assessment early closes running WINDOW attempts", async () => {
    const { admin, examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    await transitionAssessment(admin, assessment.id, "ENDED", at(T0, 5)); // sets endAt = T0+5m
    expect((await getMyAttempt(me, view.attempt.id, at(T0, 6))).attempt.status).toBe("AUTO_SUBMITTED");
  });

  it("extending the window gives a capped attempt its time back, up to the duration", async () => {
    const { admin, examLogin, rahul, endAt, assessment } = await scenario();
    const late = at(endAt, -20);
    const me = await examLogin(rahul.email, late);
    const view = await startOrResumeAttempt(me, late);
    await updateAssessment(admin, assessment.id, { endAt: at(endAt, 120) }, late);
    expect((await getMyAttempt(me, view.attempt.id, late)).attempt.deadlineAt).toEqual(at(late, 60));
  });

  it("an admin listing closes expired attempts without any background worker", async () => {
    const { admin, examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);
    await startOrResumeAttempt(me, T0);
    expect(await closeExpiredAttempts(at(T0, 30))).toBe(0);
    const rows = await listAttempts(admin, assessment.id, at(T0, 90));
    expect(rows.map((r) => r.status)).toEqual(["AUTO_SUBMITTED"]);
  });
});

// ---------------------------------------------------------------------------
describe("submission", () => {
  it("submits with the final answers in one transaction and becomes immutable", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const [single, , written] = questionsOf(view);
    await saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: [single.options[1].id] }] }, at(T0, 5));

    const result = await submitAttempt(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Final answer" }] }, at(T0, 30));

    expect(result).toMatchObject({ status: "SUBMITTED", submittedAt: at(T0, 30), savedResponses: 2, alreadySubmitted: false });
    const again = await submitAttempt(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Changed!" }] }, at(T0, 31));
    expect(again).toMatchObject({ status: "SUBMITTED", alreadySubmitted: true, submittedAt: at(T0, 30) });
    const stored = await db.attemptResponse.findFirstOrThrow({ where: { assessmentQuestionId: written.assessmentQuestionId } });
    expect(stored.textAnswer).toBe("Final answer");
    expect(await db.auditLog.count({ where: { action: AuditAction.ATTEMPT_SUBMITTED } })).toBe(1);
  });

  it("an invalid final answer rejects the whole submission (nothing half-submitted)", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const [single, , written] = questionsOf(view);
    await expectError(
      submitAttempt(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "ok" }, { assessmentQuestionId: single.assessmentQuestionId, selectedOptionIds: ["bogus"] }] }, at(T0, 10)),
      ValidationError,
    );
    const attempt = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: view.attempt.id } });
    expect(attempt.status).toBe("IN_PROGRESS");
    expect(await db.attemptResponse.count()).toBe(0);
  });

  it("submitting after the deadline auto-submits the saved answers and ignores late ones", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const written = questionsOf(view)[2];
    await saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "On time" }] }, at(T0, 50));

    const result = await submitAttempt(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Late edit" }] }, at(T0, 65));

    expect(result).toMatchObject({ status: "AUTO_SUBMITTED", submittedAt: at(T0, 60), lateAnswersIgnored: true });
    expect((await db.attemptResponse.findFirstOrThrow()).textAnswer).toBe("On time");
  });
});

// ---------------------------------------------------------------------------
describe("security", () => {
  it("a learner can't read, save to or submit another learner's attempt", async () => {
    const { examLogin, rahul, priya, T0 } = await scenario();
    const r = await examLogin(rahul.email);
    const p = await examLogin(priya.email);
    const rv = await startOrResumeAttempt(r, T0);
    const q = questionsOf(rv)[2];

    await expectError(getMyAttempt(p, rv.attempt.id, T0), NotFoundError);
    await expectError(saveResponses(p, rv.attempt.id, { responses: [{ assessmentQuestionId: q.assessmentQuestionId, textAnswer: "Sabotage" }] }, T0), NotFoundError);
    await expectError(submitAttempt(p, rv.attempt.id, {}, T0), NotFoundError);
    await expectError(getMyAttempt(r, "made-up-id", T0), NotFoundError);
    expect(await db.attemptResponse.count()).toBe(0);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: rv.attempt.id } })).status).toBe("IN_PROGRESS");
  });

  it("an attempt id from another assessment doesn't work even for the same learner", async () => {
    const { examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    await expectError(getMyAttempt({ ...me, assessmentId: "another-assessment" }, view.attempt.id, T0), NotFoundError);
    expect(assessment.id).not.toBe("another-assessment");
  });

  it("staff can't act as learners; examiners can't inspect attempts; admins can (read-only)", async () => {
    const { admin, examLogin, rahul, T0, assessment } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const examiner = await createActor(Role.EXAMINER);
    for (const actor of [admin, examiner]) {
      await expectError(startOrResumeAttempt(actor, T0), ForbiddenError);
      await expectError(saveResponses(actor, view.attempt.id, { responses: [{ assessmentQuestionId: questionsOf(view)[0].assessmentQuestionId }] }, T0), ForbiddenError);
      await expectError(submitAttempt(actor, view.attempt.id, {}, T0), ForbiddenError);
    }
    await expectError(listAttempts(examiner, assessment.id, T0), ForbiddenError);
    await expectError(getAttemptForAdmin(examiner, view.attempt.id), ForbiddenError);
    await expect(listAttempts(admin, assessment.id, T0)).resolves.toEqual([expect.objectContaining({ id: view.attempt.id, learner: expect.objectContaining({ email: rahul.email }) })]);
    await expect(getAttemptForAdmin(admin, view.attempt.id)).resolves.toMatchObject({ status: "IN_PROGRESS" });
  });

  it("a learner with an attempt can't be removed from the assessment", async () => {
    const { admin, examLogin, rahul, T0, assessment, issued } = await scenario();
    await startOrResumeAttempt(await examLogin(rahul.email), T0);
    const { removeCandidate } = await import("@/server/services/candidates");
    await expectError(removeCandidate(admin, assessment.id, issued.find((i) => i.learner.id === rahul.id)!.candidateId), ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  it("concurrent starts create exactly one attempt", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const views = await Promise.all(Array.from({ length: 6 }, () => startOrResumeAttempt(me, T0)));
    expect(new Set(views.map((v) => v.attempt.id)).size).toBe(1);
    expect(await db.assessmentAttempt.count()).toBe(1);
  });

  it("concurrent autosaves of the same answer leave one consistent response", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const written = questionsOf(view)[2];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: `Version ${i}`, clientSeq: i + 1 }] }, at(T0, 1)),
      ),
    );
    const rows = await db.attemptResponse.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ textAnswer: "Version 7", clientSeq: 8 });
  });

  it("submit racing autosave: never a half state, and nothing is written after submission", async () => {
    const { examLogin, rahul, T0 } = await scenario();
    const me = await examLogin(rahul.email);
    const view = await startOrResumeAttempt(me, T0);
    const written = questionsOf(view)[2];
    const saves = Array.from({ length: 4 }, (_, i) =>
      saveResponses(me, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: `Autosave ${i}` }] }, at(T0, 2)),
    );
    const submitsP = [submitAttempt(me, view.attempt.id, {}, at(T0, 2)), submitAttempt(me, view.attempt.id, {}, at(T0, 2))];
    const [saveResults, submitResults] = await Promise.all([Promise.allSettled(saves), Promise.allSettled(submitsP)]);
    // Autosaves either landed before the submit or were refused because the attempt was closed.
    for (const r of saveResults) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
    const submits = submitResults.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(submits.every(Boolean)).toBe(true);
    expect(submits.filter((s) => s && !s.alreadySubmitted)).toHaveLength(1);
    const attempt = await db.assessmentAttempt.findUniqueOrThrow({ where: { id: view.attempt.id }, include: { responses: true } });
    expect(attempt.status).toBe("SUBMITTED");
    expect(attempt.responses.every((r) => r.updatedAt <= attempt.updatedAt)).toBe(true);
  });
});
