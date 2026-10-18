import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssessmentStatus, Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, publishAssessment, syncTimeBasedStatuses } from "@/server/services/assessments";
import {
  getMyAttempt,
  getMyAttemptClock,
  getMyExamOverview,
  PAUSED_MESSAGE,
  saveResponses,
  startOrResumeAttempt,
  submitAttempt,
  type ExamQuestion,
} from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assessmentInput, createActor, createReadyPaper, createAssessmentRow, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * Admin pause / resume of a live assessment, against assessment_test. Every call passes an explicit
 * `now` (the server clock in production), so pause lengths and remaining times are exact.
 */

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

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const MIN = 60_000;
const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * MIN);
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));

/**
 * A published assessment of two learners (one objective, one written question), open from `startAt`
 * (+1h) for `windowMinutes`, with a `durationMinutes` attempt, exam passwords issued.
 */
async function scenario(settings: { timingMode?: "WINDOW" | "FULL_DURATION"; windowMinutes?: number; durationMinutes?: number } = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections: [{ questions: [mcqSingle({ text: "Pick one" }), shortAnswer({ text: "Explain." })] }] });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const endAt = at(startAt, settings.windowMinutes ?? 180);
  const assessment = await createAssessment(
    admin,
    assessmentInput(course.id, { type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt, durationMinutes: settings.durationMinutes ?? 60, timingMode: settings.timingMode ?? "FULL_DURATION" }),
  );
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));

  async function learner(i: number, now: Date) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, now);
    if (!r.ok) throw new Error(`exam login failed: ${r.reason}`);
    return { user: (await validateSessionToken(r.token, now))!, token: r.token };
  }
  return { admin, assessment, startAt, endAt, learner };
}

const questionsOf = (sections: { items: unknown[] }[]) => sections.flatMap((s) => s.items as ExamQuestion[]);

// ===========================================================================
describe("pausing and resuming", () => {
  it("an admin pauses a live assessment and resumes it; both are recorded in the audit log", async () => {
    const { admin, assessment, startAt } = await scenario();
    const T = at(startAt, 15);
    await syncTimeBasedStatuses(T, assessment.id);

    expect(await pauseAssessment(admin, assessment.id, T)).toMatchObject({ status: "PAUSED", pausedAt: T });
    expect(await db.assessment.findUniqueOrThrow({ where: { id: assessment.id }, select: { status: true, pausedAt: true } })).toEqual({ status: "PAUSED", pausedAt: T });

    expect(await resumeAssessment(admin, assessment.id, at(T, 10))).toMatchObject({ status: "ACTIVE", pausedSeconds: 600 });
    expect(await db.assessment.findUniqueOrThrow({ where: { id: assessment.id }, select: { status: true, pausedAt: true } })).toEqual({ status: "ACTIVE", pausedAt: null });

    const audit = await db.auditLog.findMany({ where: { entityId: assessment.id, action: { in: ["assessment.paused", "assessment.resumed"] } }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ["assessment.paused", admin.id],
      ["assessment.resumed", admin.id],
    ]);
    expect(audit[1].metadata).toMatchObject({ pausedAt: T.toISOString(), resumedAt: at(T, 10).toISOString(), pausedSeconds: 600 });
  });

  it("only administrators can pause or resume (service and action)", async () => {
    const { assessment, startAt } = await scenario();
    const T = at(startAt, 15);
    await syncTimeBasedStatuses(T, assessment.id);
    for (const role of [Role.EXAMINER, Role.REVIEWER, Role.LEARNER]) {
      const actor = await createActor(role);
      await expect(pauseAssessment(actor, assessment.id, T)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(resumeAssessment(actor, assessment.id, T)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const examiner = await createUser({ role: Role.EXAMINER });
    jar.set(SESSION_COOKIE_NAME, (await createSession(examiner.id)).token);
    expect(await redirectOf(actions.pauseAssessmentAction(assessment.id))).toBe("/forbidden");
    expect(await redirectOf(actions.resumeAssessmentAction(assessment.id))).toBe("/forbidden");
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("ACTIVE");
  });

  it("refuses invalid moves: pause twice, resume a live one, pause a completed or scheduled one, after the window", async () => {
    const { admin, assessment, startAt, endAt } = await scenario();
    // Scheduled (not started): neither pause nor resume.
    await expect(pauseAssessment(admin, assessment.id, at(startAt, -10))).rejects.toThrow(/scheduled assessment can’t be paused/);
    await expect(resumeAssessment(admin, assessment.id, at(startAt, -10))).rejects.toThrow(/scheduled assessment can’t be resumed/);

    const T = at(startAt, 15);
    await expect(resumeAssessment(admin, assessment.id, T)).rejects.toThrow("This assessment isn’t paused.");
    await pauseAssessment(admin, assessment.id, T);
    await expect(pauseAssessment(admin, assessment.id, at(T, 1))).rejects.toThrow("This assessment is already paused.");

    const ended = await createAssessmentRow({ createdById: admin.id, status: AssessmentStatus.ENDED, startAt: hoursFromNow(-3), endAt: hoursFromNow(-1) });
    await expect(pauseAssessment(admin, ended.id)).rejects.toThrow(/ended assessment can’t be paused/);
    await expect(pauseAssessment(admin, ended.id)).rejects.toBeInstanceOf(ConflictError);

    // Past the window, a paused assessment has ended by the clock: it can't be resumed.
    await expect(resumeAssessment(admin, assessment.id, at(endAt, 1))).rejects.toThrow(/ended assessment can’t be resumed/);
  });

  it("concurrent pauses: exactly one succeeds; concurrent resumes credit the pause once", async () => {
    const { admin, assessment, startAt, learner } = await scenario();
    const T = at(startAt, 5);
    const { user } = await learner(0, T);
    await startOrResumeAttempt(user, T);

    const pauses = await Promise.allSettled([1, 2, 3].map(() => pauseAssessment(admin, assessment.id, at(T, 10))));
    expect(pauses.filter((p) => p.status === "fulfilled")).toHaveLength(1);
    const resumes = await Promise.allSettled([1, 2, 3].map(() => resumeAssessment(admin, assessment.id, at(T, 20))));
    expect(resumes.filter((p) => p.status === "fulfilled")).toHaveLength(1);
    expect((await db.assessmentAttempt.findFirstOrThrow({ where: { assessmentId: assessment.id } })).pausedSeconds).toBe(600);
  });
});

// ===========================================================================
describe("learners during a pause", () => {
  it("the attempt stays intact: answers kept, nothing can change, the learner stays signed in and sees the paused state", async () => {
    const { admin, assessment, startAt, learner } = await scenario();
    const T = at(startAt, 5);
    const { user, token } = await learner(0, T);
    const view = await startOrResumeAttempt(user, T);
    const [mcq, written] = questionsOf(view.sections);
    await saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: mcq.assessmentQuestionId, selectedOptionIds: [mcq.options[0].id] }, { assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Before the pause" }] }, at(T, 1));

    await pauseAssessment(admin, assessment.id, at(T, 10));
    const P = at(T, 15);
    // Still signed in, attempt still in progress with its answers, shown as paused.
    expect(await validateSessionToken(token, P)).toMatchObject({ id: user.id });
    const paused = await getMyAttempt(user, view.attempt.id, P);
    expect(paused.attempt).toMatchObject({ status: "IN_PROGRESS", paused: true });
    expect(paused.responses.map((r) => r.textAnswer ?? r.selectedOptionIds[0]).sort()).toEqual([mcq.options[0].id, "Before the pause"].sort());
    expect(await getMyAttemptClock(user, view.attempt.id, P)).toMatchObject({ status: "IN_PROGRESS", paused: true });
    expect((await getMyExamOverview(user, P)).paused).toBe(true);

    // No answering or submitting while paused; the saved answer is unchanged.
    await expect(saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "During the pause" }] }, P)).rejects.toThrow(PAUSED_MESSAGE);
    await expect(submitAttempt(user, view.attempt.id, {}, P)).rejects.toThrow(PAUSED_MESSAGE);
    expect((await db.attemptResponse.findFirstOrThrow({ where: { assessmentQuestionId: written.assessmentQuestionId } })).textAnswer).toBe("Before the pause");
    // Nobody can start a new attempt while paused.
    const other = await learner(1, P);
    await expect(startOrResumeAttempt(other.user, P)).rejects.toThrow(/paused by the administrator/);

    // After resume: the learner continues and can submit.
    await resumeAssessment(admin, assessment.id, at(T, 20));
    const R = at(T, 21);
    expect((await getMyAttempt(user, view.attempt.id, R)).attempt.paused).toBe(false);
    await saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "After the pause" }] }, R);
    expect(await submitAttempt(user, view.attempt.id, {}, at(T, 22))).toMatchObject({ status: "SUBMITTED", savedResponses: 2 });
    expect((await db.attemptResponse.findFirstOrThrow({ where: { assessmentQuestionId: written.assessmentQuestionId } })).textAnswer).toBe("After the pause");
  });
});

// ===========================================================================
describe("the timer", () => {
  const remainingAt = async (user: SessionUser, attemptId: string, now: Date) => (await getMyAttemptClock(user, attemptId, now)).remainingSeconds;

  it("stands still during a pause and the paused time isn't charged to the learner", async () => {
    const { admin, assessment, startAt, learner } = await scenario({ timingMode: "FULL_DURATION", durationMinutes: 60 });
    const T = at(startAt, 5);
    const { user } = await learner(0, T);
    const { attempt } = await startOrResumeAttempt(user, T);
    expect(await remainingAt(user, attempt.id, at(T, 20))).toBe(40 * 60);

    await pauseAssessment(admin, assessment.id, at(T, 20));
    // 20 minutes of pause: still 40 minutes left, and the attempt isn't closed even past its original deadline.
    expect(await remainingAt(user, attempt.id, at(T, 30))).toBe(40 * 60);
    expect(await remainingAt(user, attempt.id, at(T, 75))).toBe(40 * 60);
    await resumeAssessment(admin, assessment.id, at(T, 75));
    expect(await remainingAt(user, attempt.id, at(T, 75))).toBe(40 * 60);
    expect(await remainingAt(user, attempt.id, at(T, 85))).toBe(30 * 60);
    expect(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { pausedSeconds: true, status: true } })).toEqual({ pausedSeconds: 55 * 60, status: "IN_PROGRESS" });
  });

  it("several pause/resume cycles add up exactly, without double counting; a later attempt isn't credited for earlier pauses", async () => {
    const { admin, assessment, startAt, learner } = await scenario({ timingMode: "FULL_DURATION", durationMinutes: 60 });
    const T = at(startAt, 5);
    const a = await learner(0, T);
    const first = (await startOrResumeAttempt(a.user, T)).attempt;
    // Active 0–20, paused 20–40, active 40–50, paused 50–55, active 55–60: 35 minutes used.
    await pauseAssessment(admin, assessment.id, at(T, 20));
    await resumeAssessment(admin, assessment.id, at(T, 40));
    // A second learner starts between the pauses: only the second pause counts for them.
    const b = await learner(1, at(T, 45));
    const second = (await startOrResumeAttempt(b.user, at(T, 45))).attempt;
    await pauseAssessment(admin, assessment.id, at(T, 50));
    await resumeAssessment(admin, assessment.id, at(T, 55));
    expect(await remainingAt(a.user, first.id, at(T, 60))).toBe(25 * 60);
    expect(await remainingAt(b.user, second.id, at(T, 60))).toBe((60 - 10) * 60);
    expect((await db.assessmentAttempt.findMany({ where: { assessmentId: assessment.id }, orderBy: { startedAt: "asc" }, select: { pausedSeconds: true } })).map((r) => r.pausedSeconds)).toEqual([25 * 60, 5 * 60]);
  });

  it("WINDOW timing: the window end stays the limit — a pause never moves it", async () => {
    // Window 90 minutes, 90-minute duration, started 5 minutes in: the attempt is capped at the window end.
    const { admin, assessment, startAt, endAt, learner } = await scenario({ timingMode: "WINDOW", windowMinutes: 90, durationMinutes: 90 });
    const T = at(startAt, 5);
    const { user } = await learner(0, T);
    const { attempt } = await startOrResumeAttempt(user, T);
    expect(await remainingAt(user, attempt.id, at(startAt, 45))).toBe(45 * 60);
    await pauseAssessment(admin, assessment.id, at(startAt, 45));
    expect(await remainingAt(user, attempt.id, at(startAt, 60))).toBe(30 * 60); // frozen at most until the window end
    await resumeAssessment(admin, assessment.id, at(startAt, 65));
    expect(await remainingAt(user, attempt.id, at(startAt, 65))).toBe(25 * 60);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).endAt).toEqual(endAt);
  });

  it("reaching the end time while paused ends the assessment by the existing rules", async () => {
    const window = await scenario({ timingMode: "WINDOW", windowMinutes: 90, durationMinutes: 90 });
    const w = await window.learner(0, at(window.startAt, 5));
    const wa = (await startOrResumeAttempt(w.user, at(window.startAt, 5))).attempt;
    await pauseAssessment(window.admin, window.assessment.id, at(window.startAt, 80));
    const after = at(window.endAt, 5);
    await syncTimeBasedStatuses(after, window.assessment.id);
    expect(await db.assessment.findUniqueOrThrow({ where: { id: window.assessment.id }, select: { status: true, pausedAt: true } })).toEqual({ status: "ENDED", pausedAt: null });
    // WINDOW: the attempt closes at the window end with its saved answers.
    expect(await getMyAttemptClock(w.user, wa.id, after)).toMatchObject({ status: "AUTO_SUBMITTED", paused: false });
  });
});
