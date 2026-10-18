import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AssessmentStatus, AttemptStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { LOGIN_ERRORS, SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { ForbiddenError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { login } from "@/server/auth/service";
import { createSession, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { hashSessionToken } from "@/server/auth/tokens";
import { db } from "@/server/db";
import { emailProvider, TestEmailProvider } from "@/server/email";
import { deliverPendingEmails, OUTBOX_MAX_ATTEMPTS, retryDelayMs } from "@/server/email/outbox";
import { dispatchAssessmentEvent } from "@/server/services/communication";
import { revokeExamCredential } from "@/server/services/exam-credentials";
import { addMaterial, readFile } from "@/server/services/files";
import { createAssessment } from "@/server/services/assessments";
import { addPaperQuestion, addSection, createPaperRevision, createQuestionPaper, removePaperItem, removeSection } from "@/server/services/question-papers";
import { saveResponses, startOrResumeAttempt } from "@/server/services/attempts";
import { getMyResult } from "@/server/services/results";
import { createStaffAccount, issuePasswordReset, listStaff, reissueInvite, setPasswordWithToken, setStaffStatus } from "@/server/services/staff";
import { LocalDiskStorage, MemoryStorage, newStorageKey, storage } from "@/server/storage";
import { assessmentInput, createActor, createAssessmentRow, createCourse, createExamAccess, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer, TEST_EXAM_CODE, TEST_PASSWORD } from "./helpers";

/*
 * Security hardening phase 2, end to end against assessment_test: staff account lifecycle,
 * session lifetimes, results-only credential expiry, file cleanup and file security, reviewer
 * file scope, audit logging and the email outbox. In-memory storage, the test email provider and
 * the deterministic test malware scanner — nothing is written to disk (except one temp folder for
 * the path-containment check) and no email is sent.
 */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "198.51.100.20" }),
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
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const staffActions = await import("@/server/actions/staff");
const materialsRoute = await import("@/app/api/files/materials/route");
const fileRoute = await import("@/app/api/files/[id]/route");

const mail = emailProvider() as TestEmailProvider;
const store = storage() as MemoryStorage;

beforeEach(async () => {
  jar.clear();
  mail.messages.length = 0;
  vi.restoreAllMocks();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const later = (ms: number, from = new Date()) => new Date(from.getTime() + ms);
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const NEW_PASSWORD = "a long passphrase for tests";

// ===========================================================================
describe("staff account lifecycle", () => {
  it("an admin creates a staff account with no password; the one-time link sets it, then works only once", async () => {
    const admin = await createActor(Role.ADMIN);
    const { user, link } = await createStaffAccount(admin, { name: "Esha Examiner", email: " Esha@Example.com ", role: "EXAMINER" });
    expect(user).toMatchObject({ email: "esha@example.com", role: "EXAMINER" });
    expect(link.url).toMatch(/\/set-password\?token=[\w-]{43}$/);
    expect(link.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * HOUR);

    // Nothing usable is stored: no password, and only the link's hash.
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, status: true } });
    expect(row).toEqual({ passwordHash: null, status: UserStatus.ACTIVE });
    const tokens = await db.passwordToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(hashSessionToken(tokenOf(link.url)));
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(tokenOf(link.url));

    // No password yet: nothing signs in.
    expect(await login(user.email, "")).toMatchObject({ ok: false, reason: "invalid_credentials" });

    expect(await redirectOf(staffActions.setPasswordAction(null, form({ token: tokenOf(link.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD })))).toBe("/login?password=set");
    expect(await login(user.email, NEW_PASSWORD)).toMatchObject({ ok: true, user: { role: "EXAMINER" } });
    await expect(setPasswordWithToken({ token: tokenOf(link.url), password: "another long passphrase", confirm: "another long passphrase" })).rejects.toThrow(/invalid or has expired/);
    expect(await db.auditLog.count({ where: { action: { in: ["staff.created", "staff.password_link_issued", "staff.password_set"] } } })).toBe(3);
  });

  it("links expire, a newer link replaces the old one, and passwords must meet the rules", async () => {
    const admin = await createActor(Role.ADMIN);
    const { user, link } = await createStaffAccount(admin, { name: "Rhea Reviewer", email: "rhea@example.com", role: "REVIEWER" });
    await expect(setPasswordWithToken({ token: tokenOf(link.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD }, {}, later(73 * HOUR))).rejects.toThrow(/expired/);
    const second = await reissueInvite(admin, user.id);
    await expect(setPasswordWithToken({ token: tokenOf(link.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD })).rejects.toThrow(/invalid/);
    await expect(setPasswordWithToken({ token: tokenOf(second.url), password: "short", confirm: "short" })).rejects.toMatchObject({ fieldErrors: { password: expect.any(Array) } });
    await expect(setPasswordWithToken({ token: tokenOf(second.url), password: "rhea-rhea-rhea-1", confirm: "rhea-rhea-rhea-1" })).rejects.toMatchObject({
      fieldErrors: { password: ["Don’t use your email address in your password"] },
    });
    await setPasswordWithToken({ token: tokenOf(second.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    await expect(reissueInvite(admin, user.id)).rejects.toThrow(/already set a password/);
  });

  it("only administrators manage staff accounts; learners can't be created here", async () => {
    const examiner = await createUser({ role: Role.EXAMINER });
    jar.set(SESSION_COOKIE_NAME, (await createSession(examiner.id)).token);
    expect(await redirectOf(staffActions.createStaffAccountAction({ name: "X Y", email: "x@example.com", role: "ADMIN" }))).toBe("/forbidden");
    expect(await redirectOf(staffActions.setStaffStatusAction(examiner.id, false))).toBe("/forbidden");
    expect(await redirectOf(staffActions.resetStaffPasswordAction(examiner.id))).toBe("/forbidden");
    const asExaminer: SessionUser = { id: examiner.id, email: examiner.email, name: examiner.name, role: Role.EXAMINER };
    await expect(createStaffAccount(asExaminer, { name: "X Y", email: "x@example.com", role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listStaff(asExaminer)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.user.count({ where: { email: "x@example.com" } })).toBe(0);

    const admin = await createActor(Role.ADMIN);
    await expect(createStaffAccount(admin, { name: "Lee Learner", email: "lee@example.com", role: "LEARNER" })).rejects.toMatchObject({ fieldErrors: { role: expect.any(Array) } });
    await expect(createStaffAccount(admin, { name: "Dup", email: examiner.email, role: "ADMIN" })).rejects.toThrow(/already exists/);
  });

  it("disabling ends every session at once and blocks sign-in; enabling restores access", async () => {
    const admin = await createActor(Role.ADMIN);
    const examiner = await createUser({ role: Role.EXAMINER });
    const { token } = await createSession(examiner.id);
    expect(await validateSessionToken(token)).not.toBeNull();

    jar.set(SESSION_COOKIE_NAME, (await createSession(admin.id)).token);
    expect(await staffActions.setStaffStatusAction(examiner.id, false)).toEqual({ ok: true, data: undefined });
    expect(await db.session.count({ where: { userId: examiner.id } })).toBe(0);
    expect(await validateSessionToken(token)).toBeNull();
    expect(await login(examiner.email, TEST_PASSWORD)).toMatchObject({ ok: false, reason: "account_disabled" });
    expect(LOGIN_ERRORS.account_disabled).toMatch(/disabled/);

    await setStaffStatus(admin, examiner.id, UserStatus.ACTIVE);
    expect(await login(examiner.email, TEST_PASSWORD)).toMatchObject({ ok: true });
    expect(await db.auditLog.count({ where: { action: "user.status_changed", entityId: examiner.id } })).toBe(2);
  });

  it("an admin can't disable themselves or the last active administrator", async () => {
    const admin = await createActor(Role.ADMIN);
    await expect(setStaffStatus(admin, admin.id, UserStatus.DISABLED)).rejects.toThrow(/your own account/);
    const other = await createActor(Role.ADMIN);
    await setStaffStatus(admin, other.id, UserStatus.DISABLED);
    // Now `admin` is the only active administrator; even another (disabled→enabled) path can't remove them.
    await expect(setStaffStatus(other, admin.id, UserStatus.DISABLED)).rejects.toThrow(/At least one administrator/);
  });

  it("a password reset stops the old password, ends sessions and issues a working one-time link", async () => {
    const admin = await createActor(Role.ADMIN);
    const reviewer = await createUser({ role: Role.REVIEWER });
    const { token } = await createSession(reviewer.id);
    const link = await issuePasswordReset(admin, reviewer.id);
    expect(link.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * HOUR);
    expect(await validateSessionToken(token)).toBeNull();
    expect(await login(reviewer.email, TEST_PASSWORD)).toMatchObject({ ok: false, reason: "invalid_credentials" });
    await setPasswordWithToken({ token: tokenOf(link.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(await login(reviewer.email, NEW_PASSWORD)).toMatchObject({ ok: true });
    await expect(issuePasswordReset(admin, admin.id)).rejects.toThrow(/own password/);
  });
});

// ===========================================================================
describe("sessions", () => {
  it("staff: valid while active, ends after 30 idle minutes or 12 hours, and activity is tracked", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const t0 = new Date();
    const { token, expiresAt } = await createSession(admin.id, {}, {}, t0);
    expect(expiresAt.getTime() - t0.getTime()).toBe(12 * HOUR);

    expect(await validateSessionToken(token, later(29 * MIN, t0))).toMatchObject({ id: admin.id });
    // That request counted as activity, so the idle clock restarted.
    expect(await validateSessionToken(token, later(58 * MIN, t0))).toMatchObject({ id: admin.id });
    expect(await validateSessionToken(token, later(89 * MIN, t0))).toBeNull();
    expect(await db.session.count({ where: { userId: admin.id } })).toBe(0);

    // Continuously active (a request every 25 minutes) still ends at the 12-hour limit.
    const second = await createSession(admin.id, {}, {}, t0);
    for (let m = 25; m < 12 * 60; m += 25) expect(await validateSessionToken(second.token, later(m * MIN, t0))).not.toBeNull();
    expect(await validateSessionToken(second.token, later(12 * HOUR, t0))).toBeNull();
  });

  it("learner exam sessions allow a longer pause (2 hours), but not past the credential", async () => {
    const admin = await createActor(Role.ADMIN);
    const learner = await createUser({ role: Role.LEARNER });
    const long = await createAssessmentRow({ createdById: admin.id, startAt: hoursFromNow(-1), endAt: hoursFromNow(8) });
    const { credential } = await createExamAccess({ learnerId: learner.id, assessmentId: long.id, issuedById: admin.id });
    const t0 = new Date();
    const { token } = await createSession(learner.id, {}, { examCredentialId: credential.id }, t0);
    expect(await validateSessionToken(token, later(100 * MIN, t0))).toMatchObject({ assessmentId: long.id });
    expect(await validateSessionToken(token, later(100 * MIN + 121 * MIN, t0))).toBeNull();

    // Outside the credential window (and nothing in progress) the session ends even while active.
    const short = await createAssessmentRow({ createdById: admin.id, startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    const access = await createExamAccess({ learnerId: learner.id, assessmentId: short.id, issuedById: admin.id });
    const s2 = await createSession(learner.id, {}, { examCredentialId: access.credential.id }, t0);
    expect(await validateSessionToken(s2.token, later(50 * MIN, t0))).not.toBeNull();
    expect(await validateSessionToken(s2.token, later(70 * MIN, t0))).toBeNull();
  });

  it("a learner session survives the window's end while an attempt is still running (full-duration timing)", async () => {
    const admin = await createActor(Role.ADMIN);
    const learner = await createUser({ role: Role.LEARNER });
    const a = await createAssessmentRow({ createdById: admin.id, startAt: hoursFromNow(-1), endAt: hoursFromNow(1) });
    const { candidate, credential } = await createExamAccess({ learnerId: learner.id, assessmentId: a.id, issuedById: admin.id });
    const now = new Date();
    await db.assessmentAttempt.create({
      data: { assessmentId: a.id, learnerId: learner.id, candidateId: candidate.id, attemptNumber: 1, status: AttemptStatus.IN_PROGRESS, startedAt: now, deadlineAt: later(90 * MIN, now), lastActivityAt: now },
    });
    const { token } = await createSession(learner.id, {}, { examCredentialId: credential.id }, now);
    expect(await validateSessionToken(token, later(80 * MIN, now))).not.toBeNull();
    expect(await validateSessionToken(token, later(95 * MIN, now))).toBeNull();
  });

  it("revoked credentials and disabled accounts end learner sessions", async () => {
    const admin = await createActor(Role.ADMIN);
    const learner = await createUser({ role: Role.LEARNER });
    const a = await createAssessmentRow({ createdById: admin.id });
    const { credential } = await createExamAccess({ learnerId: learner.id, assessmentId: a.id, issuedById: admin.id });
    const s1 = await createSession(learner.id, {}, { examCredentialId: credential.id });
    expect(await validateSessionToken(s1.token)).not.toBeNull();
    await db.user.update({ where: { id: learner.id }, data: { status: UserStatus.DISABLED } });
    expect(await validateSessionToken(s1.token)).toBeNull();

    await db.user.update({ where: { id: learner.id }, data: { status: UserStatus.ACTIVE } });
    const s2 = await createSession(learner.id, {}, { examCredentialId: credential.id });
    await revokeExamCredential(admin, credential.id);
    expect(await validateSessionToken(s2.token)).toBeNull();
    expect(await db.auditLog.count({ where: { action: "exam_credential.revoked", entityId: credential.id } })).toBe(1);
  });
});

// ===========================================================================
describe("results-only exam credential lifetime", () => {
  async function publishedExam() {
    const admin = await createActor(Role.ADMIN);
    const learner = await createUser({ role: Role.LEARNER, email: "rita.results@example.com" });
    const publishedAt = new Date();
    const a = await createAssessmentRow({ createdById: admin.id, status: AssessmentStatus.PUBLISHED, startAt: hoursFromNow(-72), endAt: hoursFromNow(-70) });
    await db.assessment.update({ where: { id: a.id }, data: { publishedAt } });
    const { candidate, credential } = await createExamAccess({ learnerId: learner.id, assessmentId: a.id, issuedById: admin.id });
    return { admin, learner, a, candidate, credential, publishedAt };
  }

  it("works after publication for RESULTS_ACCESS_DAYS (30), then expires — for sign-in and for open sessions", async () => {
    const { learner, credential, publishedAt } = await publishedExam();
    const within = await authenticateExamCredential(learner.email, TEST_EXAM_CODE, {}, later(29 * DAY, publishedAt));
    expect(within).toMatchObject({ ok: true });
    expect(await authenticateExamCredential(learner.email, TEST_EXAM_CODE, {}, later(31 * DAY, publishedAt))).toMatchObject({ ok: false, reason: "expired" });

    // An open session ends with the results-only period (well inside its idle and absolute limits).
    const { token } = await createSession(learner.id, {}, { examCredentialId: credential.id }, later(30 * DAY - 30 * MIN, publishedAt));
    expect(await validateSessionToken(token, later(30 * DAY - 10 * MIN, publishedAt))).toMatchObject({ id: learner.id });
    expect(await validateSessionToken(token, later(30 * DAY + MIN, publishedAt))).toBeNull();
  });

  it("a revoked results-only credential can't sign in", async () => {
    const { admin, learner, credential } = await publishedExam();
    await revokeExamCredential(admin, credential.id);
    expect(await authenticateExamCredential(learner.email, TEST_EXAM_CODE)).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect((await db.examCredential.findUniqueOrThrow({ where: { id: credential.id } })).status).toBe(ExamCredentialStatus.REVOKED);
  });

  it("results-only access can't start or change an attempt, but can read the published result", async () => {
    const { learner, a, candidate, credential } = await publishedExam();
    const attempt = await db.assessmentAttempt.create({
      data: { assessmentId: a.id, learnerId: learner.id, candidateId: candidate.id, attemptNumber: 1, status: AttemptStatus.SUBMITTED, startedAt: hoursFromNow(-71), deadlineAt: hoursFromNow(-70.5), lastActivityAt: hoursFromNow(-71), submittedAt: hoursFromNow(-70.6), evaluationStatus: "COMPLETED" },
    });
    const { token } = await createSession(learner.id, {}, { examCredentialId: credential.id });
    const actor = (await validateSessionToken(token))!;
    expect(actor).toMatchObject({ assessmentId: a.id });
    await expect(startOrResumeAttempt(actor)).rejects.toThrow(/isn’t open right now/);
    const aq = await db.assessmentQuestion.findFirst({ where: { assessmentId: a.id }, select: { id: true } });
    await expect(saveResponses(actor, attempt.id, { responses: [{ assessmentQuestionId: aq?.id ?? "q1", textAnswer: "late" }] })).rejects.toThrow(/already been submitted/);
    expect(await db.assessmentAttempt.count({ where: { candidateId: candidate.id } })).toBe(1);
    expect((await getMyResult(actor, attempt.id)).resultState).toBe("AVAILABLE");
    expect(await db.auditLog.count({ where: { action: "result.viewed", entityId: attempt.id } })).toBe(1);
  });
});

// ===========================================================================
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
const CSV = Buffer.from("region,sales\nNorth,120\n");
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

async function draftWithMaterials(admin: SessionUser) {
  const course = await createCourse();
  const paper = await createQuestionPaper(admin, { name: "Files paper", courseId: course.id });
  const s1 = await addSection(admin, paper.id, { title: "A" });
  const q1 = await addPaperQuestion(admin, s1.id, shortAnswer({ text: "Read the chart" }));
  const q2 = await addPaperQuestion(admin, s1.id, mcqSingle({ text: "Keep me" }));
  const s2 = await addSection(admin, paper.id, { title: "B" });
  const q3 = await addPaperQuestion(admin, s2.id, shortAnswer({ text: "Data one" }));
  const q4 = await addPaperQuestion(admin, s2.id, shortAnswer({ text: "Data two" }));
  const m1 = await addMaterial(admin, q1.id, { name: "chart.png", data: PNG });
  const m2 = await addMaterial(admin, q2.id, { name: "kept.csv", data: CSV });
  const m3 = await addMaterial(admin, q3.id, { name: "one.csv", data: CSV });
  const m4 = await addMaterial(admin, q4.id, { name: "two.png", data: PNG });
  return { course, paper, sections: [s1, s2], items: [q1, q2, q3, q4], files: [m1.file.id, m2.file.id, m3.file.id, m4.file.id] };
}
const keyOf = async (fileId: string) => (await db.storedFile.findUnique({ where: { id: fileId }, select: { storageKey: true } }))?.storageKey;

describe("file cleanup when questions or sections are removed", () => {
  it("deleting a question removes its material, the file record and the stored bytes", async () => {
    const admin = await createActor(Role.ADMIN);
    const { items, files } = await draftWithMaterials(admin);
    const key = (await keyOf(files[0]))!;
    await removePaperItem(admin, items[0].id);
    expect(await db.paperQuestionMaterial.count({ where: { fileId: files[0] } })).toBe(0);
    expect(await db.storedFile.count({ where: { id: files[0] } })).toBe(0);
    expect(store.keys()).not.toContain(key);
    // The other question's material is untouched.
    expect(await db.storedFile.count({ where: { id: files[1] } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "file.deleted", entityId: files[0] } })).toBe(1);
  });

  it("deleting a section removes all its materials' files, and no orphan metadata remains", async () => {
    const admin = await createActor(Role.ADMIN);
    const { sections, files } = await draftWithMaterials(admin);
    const keys = [await keyOf(files[2]), await keyOf(files[3])];
    await removeSection(admin, sections[1].id);
    expect(await db.storedFile.count({ where: { id: { in: [files[2], files[3]] } } })).toBe(0);
    for (const k of keys) expect(store.keys()).not.toContain(k);
    const orphans = await db.storedFile.count({ where: { materials: { none: {} }, answerAttachments: { none: {} } } });
    expect(orphans).toBe(0);
  });

  it("a file still used by another version of the paper is kept", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const paper = await createQuestionPaper(admin, { name: "Versioned", courseId: course.id });
    const s = await addSection(admin, paper.id, { title: "A" });
    const q = await addPaperQuestion(admin, s.id, mcqSingle({ text: "With a chart" }));
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "Second" }));
    const m = await addMaterial(admin, q.id, { name: "chart.png", data: PNG });
    // An assessment uses the paper, so changes go into a new version.
    await createAssessment(admin, assessmentInput(course.id, { name: "Uses v1", paperId: paper.id }));

    const v2 = await createPaperRevision(admin, paper.id);
    const copied = await db.paperQuestion.findFirstOrThrow({ where: { paperId: v2.id, materials: { some: { fileId: m.file.id } } } });
    await removePaperItem(admin, copied.id);
    expect(await db.storedFile.count({ where: { id: m.file.id } })).toBe(1);
    expect(store.keys()).toContain(await keyOf(m.file.id));
    expect(await db.auditLog.count({ where: { action: "file.deleted" } })).toBe(0);
  });
});

// ===========================================================================
function uploadRequest(paperQuestionId: string, file: { name: string; data: Buffer }) {
  const fd = new FormData();
  fd.set("paperQuestionId", paperQuestionId);
  fd.set("file", new File([new Uint8Array(file.data)], file.name));
  return new Request("http://localhost/api/files/materials", { method: "POST", body: fd, headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } });
}
const getFile = (fileId: string, inline = false) => fileRoute.GET(new Request(`http://localhost/api/files/${fileId}${inline ? "?inline=1" : ""}`), { params: Promise.resolve({ id: fileId }) });

describe("file security", () => {
  it("an infected upload is refused, audited (without content) and nothing is stored; clean files are recorded as scanned", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const actor: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
    const { items } = await draftWithMaterials(actor);
    jar.set(SESSION_COOKIE_NAME, (await createSession(admin.id)).token);
    const before = store.keys().length;
    const files = await db.storedFile.count();

    const res = await materialsRoute.POST(uploadRequest(items[1].id, { name: "virus.csv", data: EICAR }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/malware scanner/);
    expect(store.keys().length).toBe(before);
    expect(await db.storedFile.count()).toBe(files);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "file.rejected_malware" } });
    expect(audit.metadata).toMatchObject({ fileName: "virus.csv", signature: "EICAR-Test-File" });
    expect(JSON.stringify(audit.metadata)).not.toContain("EICAR-STANDARD");

    const okRes = await materialsRoute.POST(uploadRequest(items[1].id, { name: "fine.csv", data: CSV }));
    expect(okRes.status).toBe(200);
    expect(await db.storedFile.findFirstOrThrow({ where: { fileName: "fine.csv" }, select: { scanStatus: true, scannedBy: true } })).toEqual({ scanStatus: "CLEAN", scannedBy: "test" });
  });

  it("legacy Office, SVG and macro-enabled uploads are refused through the route", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const actor: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
    const { items } = await draftWithMaterials(actor);
    jar.set(SESSION_COOKIE_NAME, (await createSession(admin.id)).token);
    const OLE = Buffer.from("d0cf11e0a1b11ae1000000", "hex");
    const macroDocx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml word/vbaProject.bin")]);
    for (const [name, data, why] of [
      ["old.doc", OLE, /no longer accepted/],
      ["old.ppt", OLE, /no longer accepted/],
      ["logo.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), /no longer accepted/],
      ["macro.docx", macroDocx, /macros/],
    ] as const) {
      const res = await materialsRoute.POST(uploadRequest(items[1].id, { name, data }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(why);
    }
  });

  it("serves files with safe headers; a legacy SVG is always a sandboxed download", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    jar.set(SESSION_COOKIE_NAME, (await createSession(admin.id)).token);
    const key = newStorageKey("material", "svg");
    await store.put(key, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"));
    const svg = await db.storedFile.create({
      data: { storageKey: key, storageDriver: "memory", fileName: "legacy.svg", extension: "svg", mimeType: "image/svg+xml", sizeBytes: 10, sha256: "x", purpose: "MATERIAL", uploadedById: admin.id },
    });
    const res = await getFile(svg.id, true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("local storage never resolves a key outside its folder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aap-storage-"));
    try {
      const local = new LocalDiskStorage(dir);
      for (const bad of ["../escape.pdf", "material/2026/10/../../../../etc/passwd", "/etc/passwd", "material\\2026\\10\\x.pdf", "material/2026/10/not-a-uuid.pdf"]) {
        await expect(local.put(bad, Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
        await expect(local.get(bad)).rejects.toThrow(/Invalid storage key/);
      }
      const key = newStorageKey("answer", "pdf");
      await local.put(key, Buffer.from("%PDF-"));
      expect((await local.get(key)).toString()).toBe("%PDF-");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe("proctor file access", () => {
  it("proctors no longer review papers, so they read no paper materials (or answers); admins read everything", async () => {
    const adminUser = await createUser({ role: Role.ADMIN });
    const admin: SessionUser = { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: adminUser.role };
    const reviewerUser = await createUser({ role: Role.REVIEWER });
    const reviewer: SessionUser = { id: reviewerUser.id, email: reviewerUser.email, name: reviewerUser.name, role: reviewerUser.role };

    const draft = await draftWithMaterials(admin);
    const legacy = await createQuestionPaper(admin, { name: "Was in review", courseId: draft.course.id });
    const s = await addSection(admin, legacy.id, { title: "A" });
    const q = await addPaperQuestion(admin, s.id, mcqSingle({ text: "Q" }));
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "Q2" }));
    const m = await addMaterial(admin, q.id, { name: "data.csv", data: CSV });
    await db.questionPaper.update({ where: { id: legacy.id }, data: { status: "IN_REVIEW" } });

    // A learner's answer file (stored directly; proctors must never reach it).
    const key = newStorageKey("answer", "csv");
    await store.put(key, CSV);
    const answer = await db.storedFile.create({ data: { storageKey: key, storageDriver: "memory", fileName: "answer.csv", extension: "csv", mimeType: "text/csv", sizeBytes: CSV.length, sha256: "x", purpose: "ANSWER", uploadedById: adminUser.id } });

    jar.set(SESSION_COOKIE_NAME, (await createSession(reviewerUser.id)).token);
    for (const id of [m.file.id, draft.files[0], draft.files[2], answer.id, "does-not-exist"]) expect((await getFile(id)).status).toBe(404);
    await expect(readFile(reviewer, m.file.id)).rejects.toThrow(/not found/i);
    // Admins can read everything.
    expect((await readFile(admin, draft.files[0])).file.fileName).toBe("chart.png");
  });
});

// ===========================================================================
describe("audit logging", () => {
  it("file reads are logged once per user and file (not per request), with no file content", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const actor: SessionUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
    const { files } = await draftWithMaterials(actor);
    jar.set(SESSION_COOKIE_NAME, (await createSession(admin.id)).token);
    for (let i = 0; i < 3; i++) expect((await getFile(files[1])).status).toBe(200);
    const rows = await db.auditLog.findMany({ where: { action: "file.accessed" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.id, entityId: files[1], ipAddress: "198.51.100.20" });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("region,sales");
  });

  it("publishing an assessment and publishing results each leave a dedicated entry; nothing secret is logged", async () => {
    const admin = await createActor(Role.ADMIN);
    const { transitionAssessment } = await import("@/server/services/assessments");
    const a = await createAssessmentRow({ createdById: admin.id, status: AssessmentStatus.RESULT_READY, startAt: hoursFromNow(-5), endAt: hoursFromNow(-4) });
    await transitionAssessment(admin, a.id, AssessmentStatus.PUBLISHED);
    expect(await db.auditLog.count({ where: { action: "results.published", entityId: a.id } })).toBe(1);

    const { link } = await createStaffAccount(admin, { name: "Nia New", email: "nia@example.com", role: "ADMIN" });
    await setPasswordWithToken({ token: tokenOf(link.url), password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    const all = JSON.stringify(await db.auditLog.findMany({ select: { metadata: true } }));
    for (const secret of [tokenOf(link.url), NEW_PASSWORD, TEST_EXAM_CODE, TEST_PASSWORD]) expect(all).not.toContain(secret);
  });
});

// ===========================================================================
describe("email outbox", () => {
  async function assessmentWithAssignmentEmail(learners = 3) {
    const admin = await createActor(Role.ADMIN);
    const a = await createAssessmentRow({ createdById: admin.id, status: AssessmentStatus.SCHEDULED, startAt: hoursFromNow(24), endAt: hoursFromNow(26) });
    const template = await db.communicationTemplate.create({
      data: { name: "Assignment", type: "ASSESSMENT", trigger: "On publish", subject: "{{assessment_name}} for {{learner_name}}", body: "Hello {{learner_name}}", status: "ACTIVE", fromName: "Exams", fromEmail: "exams@example.com", createdById: admin.id },
    });
    await db.assessmentCommunicationSetting.create({ data: { assessmentId: a.id, event: "ASSIGNMENT", enabled: true, templateId: template.id } });
    for (let i = 0; i < learners; i++) {
      const l = await createUser({ role: Role.LEARNER, name: `Pupil ${i}` });
      await db.assessmentCandidate.create({ data: { assessmentId: a.id, learnerId: l.id } });
    }
    return { admin, a };
  }

  it("the request only queues emails; the worker delivers them afterwards and records the outcome", async () => {
    const { admin, a } = await assessmentWithAssignmentEmail(3);
    const send = vi.spyOn(mail, "send");
    expect(await dispatchAssessmentEvent(a.id, "ASSIGNMENT", admin.id)).toEqual({ queued: 3 });
    expect(send).not.toHaveBeenCalled();
    const queued = await db.communicationLog.findMany();
    expect(queued.map((r) => r.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(queued[0]).toMatchObject({ provider: null, attempts: 0, fromEmail: "exams@example.com" });
    expect(queued[0].htmlBody).toContain("Hello");

    expect(await deliverPendingEmails()).toMatchObject({ claimed: 3, notDelivered: 3 });
    expect(mail.messages).toHaveLength(3);
    const done = await db.communicationLog.findMany();
    expect(done.every((r) => r.status === "NOT_DELIVERED" && r.provider === "test" && r.attempts === 1 && r.lockedUntil === null)).toBe(true);
    expect(await deliverPendingEmails()).toMatchObject({ claimed: 0 });
  });

  it("failures are retried with backoff, then marked failed after the maximum attempts", async () => {
    const { admin, a } = await assessmentWithAssignmentEmail(1);
    await dispatchAssessmentEvent(a.id, "ASSIGNMENT", admin.id);
    vi.spyOn(mail, "send").mockRejectedValue(new Error("SMTP connection refused"));
    let now = new Date();
    expect(await deliverPendingEmails({ now })).toMatchObject({ retrying: 1 });
    let row = await db.communicationLog.findFirstOrThrow();
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, error: "SMTP connection refused" });
    expect(row.nextAttemptAt!.getTime() - now.getTime()).toBe(retryDelayMs(1));
    // Not due yet.
    expect(await deliverPendingEmails({ now: later(30_000, now) })).toMatchObject({ claimed: 0 });

    for (let i = 2; i <= OUTBOX_MAX_ATTEMPTS; i++) {
      now = later(retryDelayMs(i - 1) + 1, now);
      await deliverPendingEmails({ now });
    }
    row = await db.communicationLog.findFirstOrThrow();
    expect(row).toMatchObject({ status: "FAILED", attempts: OUTBOX_MAX_ATTEMPTS });
    expect(retryDelayMs(1)).toBe(MIN);
    expect(retryDelayMs(3)).toBe(4 * MIN);
    expect(retryDelayMs(20)).toBe(HOUR);
  });

  it("concurrent workers never deliver the same email twice; an abandoned claim is taken over after its lease", async () => {
    const { admin, a } = await assessmentWithAssignmentEmail(6);
    await dispatchAssessmentEvent(a.id, "ASSIGNMENT", admin.id);
    const runs = await Promise.all([deliverPendingEmails({ limit: 4 }), deliverPendingEmails({ limit: 4 }), deliverPendingEmails({ limit: 4 })]);
    expect(runs.reduce((n, r) => n + r.claimed, 0)).toBe(6);
    expect(mail.messages).toHaveLength(6);
    expect(new Set(mail.messages.map((m) => m.to)).size).toBe(6);

    // A worker that died mid-send leaves a SENDING row; after the lease another worker sends it.
    const row = await db.communicationLog.findFirstOrThrow();
    await db.communicationLog.update({ where: { id: row.id }, data: { status: "SENDING", lockedUntil: later(5 * MIN) } });
    expect(await deliverPendingEmails()).toMatchObject({ claimed: 0 });
    expect(await deliverPendingEmails({ now: later(6 * MIN) })).toMatchObject({ claimed: 1 });
  });
});
