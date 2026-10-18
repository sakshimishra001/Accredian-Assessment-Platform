import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { ForbiddenError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { pauseAssessment, resumeAssessment } from "@/server/services/assessment-pause";
import { createAssessment, publishAssessment, syncTimeBasedStatuses } from "@/server/services/assessments";
import { extendAttempt, extendAttempts, MAX_EXTENSION_MINUTES } from "@/server/services/attempt-extension";
import { terminateAttempt } from "@/server/services/attempt-termination";
import { getMyAttempt, getMyAttemptClock, saveResponses, startOrResumeAttempt, submitAttempt, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * Administrator time extensions, against assessment_test. Explicit clocks throughout; the server's
 * effective end time (attempts.ts → effectiveDeadline) is what every check reads.
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
const REASON = "Technical issue — browser crashed";

/**
 * The prompt's example: window S → S+120 (2 hours), 60-minute duration. Learners start at S+60, so their
 * normal end is the window end (S+120).
 */
async function scenario(learners = 2, timingMode: "WINDOW" | "FULL_DURATION" = "WINDOW") {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections: [{ questions: [mcqSingle({ text: "Pick one" }), shortAnswer({ text: "Explain." })] }] });
  const batch = await createBatchWithLearners(course.id, learners);
  const S = hoursFromNow(1);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: paper.id, batchId: batch.id, startAt: S, endAt: at(S, 120), durationMinutes: 60, timingMode }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
  const T = at(S, 60);

  async function signIn(i: number, now = T) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, now);
    if (!r.ok) throw new Error(`exam login failed: ${r.reason}`);
    return { user: (await validateSessionToken(r.token, now))!, token: r.token };
  }
  async function start(i: number) {
    const l = await signIn(i);
    const view = await startOrResumeAttempt(l.user, T);
    const [mcq, written] = view.sections.flatMap((s) => s.items as ExamQuestion[]);
    return { ...l, attemptId: view.attempt.id, candidateId: issued[i].candidateId, mcq, written };
  }
  return { admin, assessment, S, T, signIn, start };
}

const remaining = async (user: Parameters<typeof getMyAttemptClock>[0], attemptId: string, now: Date) => (await getMyAttemptClock(user, attemptId, now)).remainingSeconds;

// ===========================================================================
describe("extending one learner", () => {
  it("adds the time to that attempt only — past the window, as an explicit override — and records the grant", async () => {
    const { admin, assessment, S, T, start } = await scenario();
    const a = await start(0);
    const b = await start(1);
    expect(await remaining(a.user, a.attemptId, at(T, 50))).toBe(10 * 60); // normal end: the window end S+120

    const g = await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 30, reason: ` ${REASON} ` }, at(T, 50));
    expect(g).toMatchObject({ previousEndAt: at(S, 120), newEndAt: at(S, 150), totalMinutes: 30 });
    expect(await remaining(a.user, a.attemptId, at(T, 50))).toBe(40 * 60);
    expect(await remaining(b.user, b.attemptId, at(T, 50))).toBe(10 * 60); // the other learner is unchanged

    // The assessment's own duration and window are untouched.
    expect(await db.assessment.findUniqueOrThrow({ where: { id: assessment.id }, select: { durationMinutes: true, endAt: true } })).toEqual({ durationMinutes: 60, endAt: at(S, 120) });
    expect(await db.attemptTimeExtension.findMany({ where: { attemptId: a.attemptId }, select: { minutes: true, reason: true, grantedById: true, previousEndAt: true, newEndAt: true } })).toEqual([
      { minutes: 30, reason: REASON, grantedById: admin.id, previousEndAt: at(S, 120), newEndAt: at(S, 150) },
    ]);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "attempt.time_extended", entityId: a.attemptId } });
    expect(audit).toMatchObject({ actorId: admin.id, entityType: "AssessmentAttempt" });
    expect(audit.metadata).toMatchObject({ assessmentId: assessment.id, candidateId: a.candidateId, learnerId: a.user.id, minutes: 30, reason: REASON, previousEndAt: at(S, 120).toISOString(), newEndAt: at(S, 150).toISOString() });
  });

  it("past the window end the learner keeps going until the extended end (session, saving, submitting), then time is up", async () => {
    const { admin, assessment, S, T, start } = await scenario();
    const a = await start(0);
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 30, reason: REASON }, at(T, 30));
    const after = at(S, 135);
    await syncTimeBasedStatuses(after, assessment.id);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("ENDED");
    expect(await validateSessionToken(a.token, after)).toMatchObject({ id: a.user.id });
    expect(await getMyAttemptClock(a.user, a.attemptId, after)).toMatchObject({ status: "IN_PROGRESS", remainingSeconds: 15 * 60 });
    await saveResponses(a.user, a.attemptId, { responses: [{ assessmentQuestionId: a.written.assessmentQuestionId, textAnswer: "after the window" }] }, after);
    expect((await db.attemptResponse.findFirstOrThrow({ where: { attemptId: a.attemptId } })).textAnswer).toBe("after the window");
    // At the extended end the attempt closes.
    expect(await getMyAttemptClock(a.user, a.attemptId, at(S, 151))).toMatchObject({ status: "AUTO_SUBMITTED" });
  });

  it("survives a page refresh and a reconnect (new sign-in): the server's end time is what counts", async () => {
    const { admin, assessment, T, start, signIn } = await scenario();
    const a = await start(0);
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 15, reason: REASON }, at(T, 20));
    // Refresh: the page reloads the attempt.
    expect((await getMyAttempt(a.user, a.attemptId, at(T, 21))).attempt.remainingSeconds).toBe((60 - 21 + 15) * 60);
    // Reconnect: a new sign-in, a new session — same attempt, same end.
    const again = await signIn(0, at(T, 25));
    expect(again.token).not.toBe(a.token);
    const resumed = await startOrResumeAttempt(again.user, at(T, 25));
    expect(resumed.attempt).toMatchObject({ id: a.attemptId, remainingSeconds: (60 - 25 + 15) * 60 });
  });

  it("several extensions add up; each is its own record, chained end to end", async () => {
    const { admin, assessment, S, T, start } = await scenario();
    const a = await start(0);
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 10, reason: REASON }, at(T, 10));
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 15, reason: "Second issue" }, at(T, 20));
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).extensionSeconds).toBe(25 * 60);
    const rows = await db.attemptTimeExtension.findMany({ where: { attemptId: a.attemptId }, orderBy: { createdAt: "asc" }, select: { minutes: true, previousEndAt: true, newEndAt: true } });
    expect(rows).toEqual([
      { minutes: 10, previousEndAt: at(S, 120), newEndAt: at(S, 130) },
      { minutes: 15, previousEndAt: at(S, 130), newEndAt: at(S, 145) },
    ]);
    expect(await remaining(a.user, a.attemptId, at(T, 30))).toBe((145 - 90) * 60);
  });

  it("full-duration timing: the extension moves the attempt's own deadline", async () => {
    const { admin, assessment, T, start } = await scenario(1, "FULL_DURATION");
    const a = await start(0);
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 20, reason: REASON }, at(T, 5));
    expect(await remaining(a.user, a.attemptId, at(T, 5))).toBe((60 - 5 + 20) * 60);
  });

  it("works while the assessment is paused, and the pause doesn't consume the extension", async () => {
    const { admin, assessment, T, start } = await scenario(1, "FULL_DURATION");
    const a = await start(0);
    await pauseAssessment(admin, assessment.id, at(T, 10)); // 50 minutes left
    await extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 15, reason: REASON }, at(T, 20));
    expect(await remaining(a.user, a.attemptId, at(T, 25))).toBe(65 * 60); // frozen, plus the extension
    await resumeAssessment(admin, assessment.id, at(T, 30));
    expect(await remaining(a.user, a.attemptId, at(T, 30))).toBe(65 * 60);
    expect(await remaining(a.user, a.attemptId, at(T, 40))).toBe(55 * 60);
  });

  it("only administrators; a reason and a valid amount are required", async () => {
    const { assessment, T, start } = await scenario();
    const a = await start(0);
    for (const role of [Role.EXAMINER, Role.REVIEWER, Role.LEARNER]) {
      const actor = await createActor(role);
      await expect(extendAttempt(actor, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 10, reason: REASON })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(extendAttempts(actor, { assessmentId: assessment.id, scope: "BATCH", minutes: 10, reason: REASON })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const examiner = await createUser({ role: Role.EXAMINER });
    jar.set(SESSION_COOKIE_NAME, (await createSession(examiner.id)).token);
    expect(await redirectOf(actions.extendAttemptAction(assessment.id, a.attemptId, 10, REASON))).toBe("/forbidden");
    expect(await redirectOf(actions.extendAttemptsAction(assessment.id, { scope: "BATCH", minutes: 10, reason: REASON }))).toBe("/forbidden");

    const admin = await createActor(Role.ADMIN);
    const input = (minutes: unknown, reason: unknown) => ({ assessmentId: assessment.id, attemptId: a.attemptId, minutes, reason });
    for (const reason of [undefined, "", "  ", "ab"]) await expect(extendAttempt(admin, input(10, reason), at(T, 5))).rejects.toMatchObject({ fieldErrors: { reason: expect.any(Array) } });
    for (const minutes of [0, -5, 2.5, "x", MAX_EXTENSION_MINUTES + 1, 100_000]) await expect(extendAttempt(admin, input(minutes, REASON), at(T, 5))).rejects.toMatchObject({ fieldErrors: { minutes: expect.any(Array) } });
    // The per-attempt total is capped too (480 minutes).
    await extendAttempt(admin, input(180, REASON), at(T, 5));
    await extendAttempt(admin, input(180, REASON), at(T, 5));
    await expect(extendAttempt(admin, input(180, REASON), at(T, 5))).rejects.toThrow(/at most 480 minutes in total/);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).extensionSeconds).toBe(360 * 60);
  });

  it("submitted and terminated attempts can't be extended", async () => {
    const { admin, assessment, T, start } = await scenario();
    const a = await start(0);
    const b = await start(1);
    await submitAttempt(a.user, a.attemptId, {}, at(T, 5));
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, reason: "Violation of exam rules" }, at(T, 5));
    await expect(extendAttempt(admin, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 10, reason: REASON }, at(T, 6))).rejects.toThrow("This attempt has already been submitted; time can’t be extended.");
    await expect(extendAttempt(admin, { assessmentId: assessment.id, attemptId: b.attemptId, minutes: 10, reason: REASON }, at(T, 6))).rejects.toThrow("This attempt was terminated; time can’t be extended.");
    expect(await db.attemptTimeExtension.count()).toBe(0);
  });

  it("concurrent extensions all count, in order, with no lost update", async () => {
    const { admin, assessment, S, T, start } = await scenario();
    const a = await start(0);
    const other = await createActor(Role.ADMIN);
    await Promise.all([admin, other, admin].map((actor) => extendAttempt(actor, { assessmentId: assessment.id, attemptId: a.attemptId, minutes: 10, reason: REASON }, at(T, 10))));
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: a.attemptId } })).extensionSeconds).toBe(30 * 60);
    const ends = (await db.attemptTimeExtension.findMany({ where: { attemptId: a.attemptId }, select: { previousEndAt: true, newEndAt: true } })).map((r) => [r.previousEndAt.getTime(), r.newEndAt.getTime()]);
    expect(ends.map(([p]) => p).sort()).toEqual([at(S, 120), at(S, 130), at(S, 140)].map((d) => d.getTime()));
    expect(ends.map(([, n]) => n).sort()).toEqual([at(S, 130), at(S, 140), at(S, 150)].map((d) => d.getTime()));
    expect(await remaining(a.user, a.attemptId, at(T, 10))).toBe(80 * 60);
  });
});

// ===========================================================================
describe("extending several learners", () => {
  it("the whole batch: only attempts in progress; submitted, terminated and not-started learners unchanged; audited per attempt and in bulk", async () => {
    const { admin, assessment, T, start } = await scenario(5);
    const running = [await start(0), await start(1)];
    const submitted = await start(2);
    await submitAttempt(submitted.user, submitted.attemptId, {}, at(T, 5));
    const terminated = await start(3);
    await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: terminated.attemptId, reason: "Duplicate attempt" }, at(T, 5));
    // Learner 5 never starts.

    const r = await extendAttempts(admin, { assessmentId: assessment.id, scope: "BATCH", minutes: 30, reason: "Technical issue affecting the batch" }, at(T, 10));
    expect(r).toMatchObject({ extended: 2, skipped: 0 });
    const rows = await db.assessmentAttempt.findMany({ where: { assessmentId: assessment.id }, select: { id: true, status: true, extensionSeconds: true } });
    expect(rows).toHaveLength(4);
    for (const x of running) expect(rows.find((y) => y.id === x.attemptId)).toMatchObject({ status: "IN_PROGRESS", extensionSeconds: 1800 });
    expect(rows.find((y) => y.id === submitted.attemptId)).toMatchObject({ status: "SUBMITTED", extensionSeconds: 0 });
    expect(rows.find((y) => y.id === terminated.attemptId)).toMatchObject({ status: "TERMINATED", extensionSeconds: 0 });
    expect(await db.assessmentCandidate.count({ where: { assessmentId: assessment.id, attempts: { none: {} } } })).toBe(1);

    const bulk = await db.auditLog.findFirstOrThrow({ where: { action: "attempt.bulk_time_extended", entityId: assessment.id } });
    const meta = bulk.metadata as { operationId: string; scope: string; extended: number; attempts: { attemptId: string; learnerId: string; previousEndAt: string; newEndAt: string }[] };
    expect(meta).toMatchObject({ scope: "BATCH", extended: 2, minutes: 30 });
    expect(meta.attempts.map((x) => x.attemptId).sort()).toEqual(running.map((x) => x.attemptId).sort());
    const each = await db.auditLog.findMany({ where: { action: "attempt.time_extended" } });
    expect(each.map((e) => e.entityId).sort()).toEqual(running.map((x) => x.attemptId).sort());
    expect(each.every((e) => (e.metadata as { bulkOperationId: string }).bulkOperationId === meta.operationId)).toBe(true);
    expect(await db.attemptTimeExtension.count({ where: { bulkOperationId: meta.operationId } })).toBe(2);
  });

  it("selected learners: running ones are extended, a selected one that has submitted is skipped, unknown ids are refused", async () => {
    const { admin, assessment, T, start } = await scenario(3);
    const a = await start(0);
    const b = await start(1);
    const c = await start(2);
    await submitAttempt(b.user, b.attemptId, {}, at(T, 5));
    expect(await extendAttempts(admin, { assessmentId: assessment.id, scope: "SELECTED", attemptIds: [a.attemptId, b.attemptId], minutes: 10, reason: REASON }, at(T, 10))).toMatchObject({ extended: 1, skipped: 1 });
    const ext = Object.fromEntries((await db.assessmentAttempt.findMany({ where: { assessmentId: assessment.id }, select: { id: true, extensionSeconds: true } })).map((r) => [r.id, r.extensionSeconds]));
    expect(ext).toEqual({ [a.attemptId]: 600, [b.attemptId]: 0, [c.attemptId]: 0 });

    const other = await scenario(1);
    const stranger = await other.start(0);
    await expect(extendAttempts(admin, { assessmentId: assessment.id, scope: "SELECTED", attemptIds: [a.attemptId, stranger.attemptId], minutes: 10, reason: REASON }, at(T, 10))).rejects.toThrow(/aren’t part of this assessment/);
    await expect(extendAttempts(admin, { assessmentId: assessment.id, scope: "SELECTED", attemptIds: [], minutes: 10, reason: REASON }, at(T, 10))).rejects.toThrow(/Select at least one learner/);
  });
});
