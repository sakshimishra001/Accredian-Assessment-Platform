import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { authenticateExamCredential, authenticateLearner } from "@/server/auth/exam-login";
import { login } from "@/server/auth/service";
import { forAssessment, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessmentForBatch } from "@/server/services/assessments";
import { getMyAttemptClock, getMyExamOverview, recordProctoringEvent, saveResponses, startOrResumeAttempt, submitAttempt } from "@/server/services/attempts";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { getLearnerLandingPath, listMyAssessments } from "@/server/services/learner-home";
import { issueLearnerPasswords } from "@/server/services/learner-passwords";
import { assessmentInput, createActor, createBatchWithLearners, createCourse, createReadyPaper, createUser, hoursFromNow, resetDatabase, TEST_PASSWORD } from "./helpers";

/*
 * One persistent password per learner (User.passwordHash) for all their assigned assessments;
 * assignment, not the password, decides access. Post-login routing from the server's state.
 */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

/** Two assessments for one batch: X opens in 1 h (3 h window); Y opens in 6 h. */
async function world(opts: { yOpensWithX?: boolean } = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id);
  const batch = await createBatchWithLearners(course.id, 2);
  const xStart = hoursFromNow(1);
  const yStart = opts.yOpensWithX ? xStart : hoursFromNow(6);
  const make = async (name: string, startAt: Date) => {
    const a = await createAssessment(admin, assessmentInput(course.id, { name, paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION" }));
    await publishAssessmentForBatch(admin, a.id);
    return a;
  };
  const x = await make("Assessment X", xStart);
  const y = await make("Assessment Y", yStart);
  const issued = (await issueLearnerPasswords(admin, x.id)).sort((p, q) => p.learner.name.localeCompare(q.learner.name));
  const T = at(xStart, 5);
  async function signIn(i = 0, now = T): Promise<SessionUser> {
    const r = await authenticateLearner(issued[i].learner.email, issued[i].password, {}, now);
    if (!r.ok) throw new Error(r.reason);
    return (await validateSessionToken(r.token, now))!;
  }
  return { admin, course, paper, batch, x, y, issued, T, signIn };
}

describe("persistent learner password", () => {
  it("A: one password signs the learner in for both of their assessments (no per-assessment credential)", async () => {
    const w = await world({ yOpensWithX: true });
    expect(w.issued).toHaveLength(2);
    expect(w.issued[0].password).toMatch(/^[A-Z0-9]{10}$/);
    const user = await w.signIn();
    expect(user).toMatchObject({ role: "LEARNER" });
    expect(user.assessmentId).toBeUndefined();
    expect(user.examCredentialId).toBeUndefined();
    // The same session opens X and Y — each because the learner is assigned to it.
    for (const a of [w.x, w.y]) {
      expect((await getMyExamOverview(forAssessment(user, a.id), w.T)).assessment.id).toBe(a.id);
      const view = await startOrResumeAttempt(forAssessment(user, a.id), w.T);
      expect(view.attempt.status).toBe("IN_PROGRESS");
    }
    expect(await db.examCredential.count()).toBe(0);
    // Stored as a bcrypt hash only; the plain password appears nowhere.
    const row = await db.user.findUniqueOrThrow({ where: { id: w.issued[0].learner.id } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(w.issued[0].password);
  });

  it("B: a wrong password, another learner's password and an unknown email are all rejected alike", async () => {
    const w = await world();
    const [a, b] = w.issued;
    for (const [email, password] of [
      [a.learner.email, "WRONGPASS1"],
      [a.learner.email, b.password],
      ["nobody@example.com", a.password],
    ]) {
      expect(await authenticateLearner(email, password, {}, w.T)).toEqual({ ok: false, reason: "invalid_credentials" });
    }
    expect(await db.session.count()).toBe(0);
  });

  it("issuing only fills in missing passwords; a reset replaces them and ends sessions", async () => {
    const w = await world();
    expect(await issueLearnerPasswords(w.admin, w.y.id)).toEqual([]); // everyone already has one
    const user = await w.signIn();
    const reset = await issueLearnerPasswords(w.admin, w.y.id, { reset: true });
    expect(reset).toHaveLength(2);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await authenticateLearner(w.issued[0].learner.email, w.issued[0].password, {}, w.T)).toMatchObject({ ok: false });
    const fresh = reset.find((r) => r.learner.id === user.id)!;
    expect(await authenticateLearner(fresh.learner.email, fresh.password, {}, w.T)).toMatchObject({ ok: true, method: "password" });
  });

  it("migration: a learner without a password can still use a valid exam password; once they have one, it stops working", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createReadyPaper(admin, course.id);
    const batch = await createBatchWithLearners(course.id, 1);
    const startAt = hoursFromNow(1);
    const a = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION" }));
    await publishAssessmentForBatch(admin, a.id);
    const [legacy] = await issueExamCredentials(admin, a.id);
    const T = at(startAt, 5);
    const r = await authenticateLearner(legacy.learner.email, legacy.code.toLowerCase(), {}, T);
    expect(r).toMatchObject({ ok: true, method: "exam_credential" });
    const user = (await validateSessionToken(r.ok ? r.token : null, T))!;
    expect((await startOrResumeAttempt(forAssessment(user, a.id), T)).attempt.status).toBe("IN_PROGRESS");

    const [issued] = await issueLearnerPasswords(admin, a.id);
    // A first password doesn't sign the learner out mid-exam…
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    // …but the old exam password no longer signs in, and the new password does.
    expect(await authenticateLearner(legacy.learner.email, legacy.code, {}, T)).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateExamCredential(legacy.learner.email, legacy.code, {}, T)).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateLearner(issued.learner.email, issued.password, {}, T)).toMatchObject({ ok: true, method: "password" });
  });
});

describe("access is by assignment", () => {
  it("C: knowing another assessment's URL/id grants nothing — it isn't the learner's", async () => {
    const w = await world();
    const user = await w.signIn();
    const other = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createReadyPaper(other, course.id);
    const batch = await createBatchWithLearners(course.id, 1);
    const foreign = await createAssessment(other, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(1), endAt: hoursFromNow(4), durationMinutes: 60 }));
    await publishAssessmentForBatch(other, foreign.id);
    await expect(getMyExamOverview(forAssessment(user, foreign.id), w.T)).rejects.toBeInstanceOf(NotFoundError);
    await expect(startOrResumeAttempt(forAssessment(user, foreign.id), w.T)).rejects.toBeInstanceOf(ConflictError);
    expect(await db.assessmentAttempt.count({ where: { assessmentId: foreign.id } })).toBe(0);
    expect((await listMyAssessments(user, w.T)).map((o) => o.assessment.id).sort()).toEqual([w.x.id, w.y.id].sort());
  });

  it("drafts are never shown to a learner, even if assigned", async () => {
    const w = await world();
    const user = await w.signIn();
    const draft = await createAssessment(w.admin, assessmentInput(w.course.id, { name: "Draft", paperId: w.paper.id, batchId: w.batch.id }));
    await db.assessmentCandidate.create({ data: { assessmentId: draft.id, learnerId: user.id } });
    await expect(getMyExamOverview(forAssessment(user, draft.id), w.T)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMyAssessments(user, w.T)).map((o) => o.assessment.id)).not.toContain(draft.id);
  });
});

describe("post-login routing (server-side)", () => {
  it("D: one active, unattempted assessment → its instructions; an attempt in progress → the same", async () => {
    const w = await world();
    const user = await w.signIn();
    expect(await getLearnerLandingPath(user, w.T)).toBe(`/learner/assessment/${w.x.id}`);
    await startOrResumeAttempt(forAssessment(user, w.x.id), w.T);
    expect(await getLearnerLandingPath(user, at(w.T, 1))).toBe(`/learner/assessment/${w.x.id}`);
  });

  it("E: no assessment assigned → dashboard", async () => {
    const learner = await createUser({ role: Role.LEARNER });
    expect(await getLearnerLandingPath({ id: learner.id, email: learner.email, name: learner.name, role: Role.LEARNER })).toBe("/learner");
  });

  it("F: only scheduled (future) assessments → dashboard, shown as upcoming", async () => {
    const w = await world();
    const now = new Date();
    const user = await w.signIn(0, now);
    expect(await getLearnerLandingPath(user, now)).toBe("/learner");
  });

  it("G: submitted → dashboard; terminated → dashboard (no restart)", async () => {
    const w = await world();
    const user = await w.signIn();
    const view = await startOrResumeAttempt(forAssessment(user, w.x.id), w.T);
    await submitAttempt(user, view.attempt.id, { responses: [] }, at(w.T, 2));
    expect(await getLearnerLandingPath(user, at(w.T, 3))).toBe("/learner");

    const other = await w.signIn(1);
    const v2 = await startOrResumeAttempt(forAssessment(other, w.x.id), w.T);
    await db.assessmentAttempt.update({ where: { id: v2.attempt.id }, data: { status: "TERMINATED", terminatedAt: w.T, terminationReason: "test" } });
    expect(await getLearnerLandingPath(other, at(w.T, 3))).toBe("/learner");
    await expect(startOrResumeAttempt(forAssessment(other, w.x.id), at(w.T, 4))).rejects.toBeInstanceOf(ConflictError);
  });

  it("several active assessments at once → dashboard (the learner chooses)", async () => {
    const w = await world({ yOpensWithX: true });
    const user = await w.signIn();
    expect(await getLearnerLandingPath(user, w.T)).toBe("/learner");
    // …unless one of them is already running: that one.
    await startOrResumeAttempt(forAssessment(user, w.y.id), w.T);
    expect(await getLearnerLandingPath(user, w.T)).toBe(`/learner/assessment/${w.y.id}`);
  });
});

describe("unchanged", () => {
  it("J: staff sign in with their password; a learner's password never works on the staff login", async () => {
    const w = await world();
    const admin = await createUser({ role: Role.ADMIN, email: "staff.admin@example.com" });
    expect(await login(admin.email, TEST_PASSWORD)).toMatchObject({ ok: true, user: { role: "ADMIN" } });
    expect(await login(w.issued[0].learner.email, w.issued[0].password)).toEqual({ ok: false, reason: "invalid_credentials" });
    // …and staff can't use the learner sign-in.
    expect(await authenticateLearner(admin.email, TEST_PASSWORD, {}, w.T)).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("K: proctoring events and enforcement work for a password-session learner", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createReadyPaper(admin, course.id);
    const batch = await createBatchWithLearners(course.id, 1);
    const startAt = hoursFromNow(1);
    const a = await createAssessment(
      admin,
      assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION", proctoringEnabled: true, focusMonitoringEnabled: true, cameraRequired: true, focusMaxViolations: 2, focusViolationAction: "TERMINATE" }),
    );
    await publishAssessmentForBatch(admin, a.id);
    const [p] = await issueLearnerPasswords(admin, a.id);
    const T = at(startAt, 5);
    const r = await authenticateLearner(p.learner.email, p.password, {}, T);
    const user = (await validateSessionToken(r.ok ? r.token : null, T))!;
    const view = await startOrResumeAttempt(forAssessment(user, a.id), T);
    expect(view.assessment).toMatchObject({ focusMonitoring: { maxViolations: 2, action: "TERMINATE" }, camera: { maxViolations: 2, action: "TERMINATE" } });
    expect(await recordProctoringEvent(user, view.attempt.id, { eventType: "CAMERA_DISABLED", incidentId: "incident-aaaa-1" }, at(T, 1))).toMatchObject({ recorded: true, outcome: "WARNING", violations: 1 });
    expect(await recordProctoringEvent(user, view.attempt.id, { eventType: "FOCUS_LOST", incidentId: "incident-aaaa-2" }, at(T, 2))).toMatchObject({ recorded: true, outcome: "TERMINATED", violations: 2 });
  });
});

describe("regression: legacy exam-password session taking another assigned assessment", () => {
  it("answers save, the clock and proctoring work on the attempt the exam shows; refresh resumes the same attempt", async () => {
    // Two assessments for one batch, both open; the learner's legacy exam password is for A only.
    const w = await world({ yOpensWithX: true });
    const legacyLearnerId = w.issued[0].learner.id;
    await db.user.update({ where: { id: legacyLearnerId }, data: { passwordHash: null } });
    const [legacy] = (await issueExamCredentials(w.admin, w.x.id)).filter((c) => c.learner.id === legacyLearnerId);
    const r = await authenticateExamCredential(legacy.learner.email, legacy.code, {}, w.T);
    const session = (await validateSessionToken(r.ok ? r.token : null, w.T))!;
    expect(session.assessmentId).toBe(w.x.id); // the session's default (legacy) assessment

    // The learner opens Y (the page takes the assessment from the URL).
    const view = await startOrResumeAttempt(forAssessment(session, w.y.id), w.T);
    const q = view.sections.flatMap((s) => s.items)[0] as { assessmentQuestionId: string; options: { id: string }[] };
    // The actions then use the session actor as-is — they must still find Y's attempt.
    expect(await saveResponses(session, view.attempt.id, { responses: [{ assessmentQuestionId: q.assessmentQuestionId, selectedOptionIds: [q.options[0].id], clientSeq: 1 }] }, at(w.T, 1))).toMatchObject({ saved: 1 });
    expect(await getMyAttemptClock(session, view.attempt.id, at(w.T, 1))).toMatchObject({ status: "IN_PROGRESS" });
    const saved = await db.attemptResponse.findFirstOrThrow({ where: { attemptId: view.attempt.id } });
    expect(saved).toMatchObject({ assessmentId: w.y.id, selectedOptionIds: [q.options[0].id] });

    // Refresh: the same attempt, with the saved answer.
    const again = await startOrResumeAttempt(forAssessment(session, w.y.id), at(w.T, 2));
    expect(again.attempt.id).toBe(view.attempt.id);
    expect(again.responses).toEqual([expect.objectContaining({ assessmentQuestionId: q.assessmentQuestionId, selectedOptionIds: [q.options[0].id] })]);

    // Another learner still can't touch it.
    const other = await w.signIn(1);
    await expect(getMyAttemptClock(other, view.attempt.id, at(w.T, 2))).rejects.toBeInstanceOf(NotFoundError);
  });
});
