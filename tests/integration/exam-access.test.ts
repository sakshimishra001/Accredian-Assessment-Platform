import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AssessmentStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { verifyPassword } from "@/server/auth/password";
import { login } from "@/server/auth/service";
import { validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  assignBatchToAssessment,
  assignExaminer,
  assignLearnersToAssessment,
  getCandidate,
  getMyCandidacy,
  listCandidates,
  listExaminerAssessments,
  removeCandidate,
} from "@/server/services/candidates";
import { issueExamCredentials, listExamCredentials, revokeExamCredential } from "@/server/services/exam-credentials";
import { addLearnersToBatch, createLearner, listExaminers, listLearners, setLearnerStatus } from "@/server/services/learners";
import { createActor, createAssessmentRow, createCourse, createUser, hoursFromNow, resetDatabase, TEST_PASSWORD } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

/** Signs a learner in with their exam password and returns the session user (with assessment scope). */
async function examSession(email: string, code: string, now?: Date): Promise<SessionUser> {
  const result = await authenticateExamCredential(email, code, {}, now);
  if (!result.ok) throw new Error(`exam login failed: ${result.reason}`);
  const user = await validateSessionToken(result.token, now);
  if (!user) throw new Error("session not valid");
  return user;
}

/**
 * Scenario: one course, two open assessments (AI Final, Leadership), three learners, two examiners.
 * Rahul and Priya sit AI Final; Rahul also sits Leadership. Examiner 1 marks Rahul in AI Final,
 * Examiner 2 marks Priya in AI Final and Rahul in Leadership.
 */
async function scenario() {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const aiFinal = await createAssessmentRow({ name: "AI Final Exam", courseId: course.id, createdById: admin.id });
  const leadership = await createAssessmentRow({ name: "Leadership Exam", courseId: course.id, createdById: admin.id });
  const rahul = await createLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com" });
  const priya = await createLearner(admin, { name: "Priya Nair", email: "priya@gmail.com" });
  const amit = await createLearner(admin, { name: "Amit Rao", email: "amit@gmail.com" });
  const examiner1 = await createActor(Role.EXAMINER);
  const examiner2 = await createActor(Role.EXAMINER);

  await assignLearnersToAssessment(admin, aiFinal.id, [rahul.id, priya.id, amit.id]);
  await assignLearnersToAssessment(admin, leadership.id, [rahul.id]);
  const aiCandidates = await listCandidates(admin, aiFinal.id);
  const byEmail = (list: typeof aiCandidates, email: string) => list.find((c) => c.learner.email === email)!;
  const aiRahul = byEmail(aiCandidates, "rahul@gmail.com");
  const aiPriya = byEmail(aiCandidates, "priya@gmail.com");
  const aiAmit = byEmail(aiCandidates, "amit@gmail.com");
  const leadRahul = byEmail(await listCandidates(admin, leadership.id), "rahul@gmail.com");

  await assignExaminer(admin, aiFinal.id, [aiRahul.id], examiner1.id);
  await assignExaminer(admin, aiFinal.id, [aiPriya.id], examiner2.id);
  await assignExaminer(admin, leadership.id, [leadRahul.id], examiner2.id);

  return { admin, course, aiFinal, leadership, rahul, priya, amit, examiner1, examiner2, aiRahul, aiPriya, aiAmit, leadRahul };
}

const codeFor = (issued: Awaited<ReturnType<typeof issueExamCredentials>>, email: string) => issued.find((i) => i.learner.email === email)!.code;

// ---------------------------------------------------------------------------
describe("learner identity", () => {
  it("identifies a learner by a unique, normalised email with no password and optional batch", async () => {
    const admin = await createActor(Role.ADMIN);
    const course = await createCourse();
    const batch = await db.batch.create({ data: { code: "AIL-SEP26", name: "AI Leaders - September 2026", courseId: course.id } });

    const learner = await createLearner(admin, { name: "Rahul Sharma", email: "  Rahul@Gmail.com ", batchId: batch.id });

    expect(learner).toMatchObject({ name: "Rahul Sharma", email: "rahul@gmail.com", status: UserStatus.ACTIVE });
    expect(learner.batchMemberships.map((m) => m.batch.name)).toEqual(["AI Leaders - September 2026"]);
    expect(learner).not.toHaveProperty("passwordHash");
    const row = await db.user.findUniqueOrThrow({ where: { id: learner.id } });
    expect(row).toMatchObject({ role: Role.LEARNER, passwordHash: null });
  });

  it("rejects a duplicate email, whatever the case, in the service and in the database", async () => {
    const admin = await createActor(Role.ADMIN);
    await createLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com" });

    await expect(createLearner(admin, { name: "Rahul S", email: "RAHUL@gmail.com" })).rejects.toBeInstanceOf(ConflictError);
    await expect(db.user.create({ data: { name: "Dup", email: "rahul@gmail.com", role: Role.LEARNER } })).rejects.toThrow();
    expect(await db.user.count({ where: { email: "rahul@gmail.com" } })).toBe(1);
  });

  it("validates learner input", async () => {
    const admin = await createActor(Role.ADMIN);
    await expect(createLearner(admin, { name: "R", email: "not-an-email" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not let a disabled learner authenticate, and disabling ends their session", async () => {
    const { admin, aiFinal, rahul } = await scenario();
    const [issued] = await issueExamCredentials(admin, aiFinal.id, { candidateIds: [(await listCandidates(admin, aiFinal.id)).find((c) => c.learner.id === rahul.id)!.id] });
    const first = await authenticateExamCredential("rahul@gmail.com", issued.code);
    expect(first.ok).toBe(true);

    await setLearnerStatus(admin, rahul.id, UserStatus.DISABLED);

    await expect(authenticateExamCredential("rahul@gmail.com", issued.code)).resolves.toMatchObject({ ok: false, reason: "account_disabled" });
    if (first.ok) await expect(validateSessionToken(first.token)).resolves.toBeNull();
  });

  it("only admins manage learners", async () => {
    const examiner = await createActor(Role.EXAMINER);
    await expect(createLearner(examiner, { name: "X Y", email: "x@example.com" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLearners(examiner)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
describe("exam credentials", () => {
  it("authenticates a learner into exactly the assessment the credential was issued for", async () => {
    const { admin, aiFinal } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);

    const user = await examSession("rahul@gmail.com", codeFor(issued, "rahul@gmail.com"));

    expect(user).toMatchObject({ email: "rahul@gmail.com", role: Role.LEARNER, assessmentId: aiFinal.id });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.EXAM_LOGIN_SUCCEEDED } });
    expect(audit.metadata).toMatchObject({ assessmentId: aiFinal.id });
  });

  it("belongs to one learner + one assessment and is stored only as a bcrypt hash", async () => {
    const { admin, aiFinal, rahul } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);
    const mine = issued.find((i) => i.learner.id === rahul.id)!;

    expect(mine.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const row = await db.examCredential.findUniqueOrThrow({ where: { id: mine.credentialId }, include: { candidate: true } });
    expect(row.candidate).toMatchObject({ learnerId: rahul.id, assessmentId: aiFinal.id });
    expect(row.codeHash).not.toContain(mine.code);
    expect(row.codeHash).toMatch(/^\$2[aby]\$12\$/);
    await expect(verifyPassword(mine.code, row.codeHash)).resolves.toBe(true);
    // No table stores the plain code.
    expect(JSON.stringify(await db.examCredential.findMany())).not.toContain(mine.code);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(mine.code);
  });

  it("gives the same learner different credentials for different assessments", async () => {
    const { admin, aiFinal, leadership } = await scenario();
    const ai = codeFor(await issueExamCredentials(admin, aiFinal.id), "rahul@gmail.com");
    const lead = codeFor(await issueExamCredentials(admin, leadership.id), "rahul@gmail.com");

    await expect(examSession("rahul@gmail.com", ai)).resolves.toMatchObject({ assessmentId: aiFinal.id });
    await expect(examSession("rahul@gmail.com", lead)).resolves.toMatchObject({ assessmentId: leadership.id });
  });

  it("cannot be used with another learner's email or for another assessment", async () => {
    const { admin, aiFinal, leadership, rahul } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);
    const rahulCode = codeFor(issued, "rahul@gmail.com");

    await expect(authenticateExamCredential("priya@gmail.com", rahulCode)).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });

    // Rahul's AI Final session gives no access to his Leadership candidacy.
    const session = await examSession("rahul@gmail.com", rahulCode);
    const leadCandidate = (await listCandidates(admin, leadership.id)).find((c) => c.learner.id === rahul.id)!;
    await expect(getCandidate(session, leadership.id, leadCandidate.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listCandidates(session, leadership.id)).resolves.toEqual([]);
    await expect(getMyCandidacy(session)).resolves.toMatchObject({ assessment: { id: aiFinal.id } });
  });

  it("defaults the validity window to the assessment schedule and enforces it", async () => {
    const { admin, aiFinal } = await scenario();
    const [cred] = await issueExamCredentials(admin, aiFinal.id);
    expect(cred.validFrom).toEqual(aiFinal.startAt);
    expect(cred.validUntil).toEqual(aiFinal.endAt);

    const code = cred.code;
    const email = cred.learner.email;
    const before = new Date(aiFinal.startAt.getTime() - 60_000);
    const atEnd = new Date(aiFinal.endAt.getTime());
    await expect(authenticateExamCredential(email, code, {}, before)).resolves.toMatchObject({ ok: false, reason: "not_yet_valid" });
    await expect(authenticateExamCredential(email, code, {}, atEnd)).resolves.toMatchObject({ ok: false, reason: "expired" });
    await expect(authenticateExamCredential(email, code)).resolves.toMatchObject({ ok: true });
  });

  it("accepts a custom window and rejects an impossible one", async () => {
    const { admin, aiFinal, aiRahul } = await scenario();
    const validUntil = hoursFromNow(5);
    const [cred] = await issueExamCredentials(admin, aiFinal.id, { candidateIds: [aiRahul.id], window: { validUntil } });
    expect(cred.validUntil).toEqual(validUntil);

    await expect(
      issueExamCredentials(admin, aiFinal.id, { candidateIds: [aiRahul.id], window: { validFrom: hoursFromNow(3), validUntil: hoursFromNow(2) } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(issueExamCredentials(admin, aiFinal.id, { window: { validUntil: hoursFromNow(-1) } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("stops working after revocation and ends sessions opened with it", async () => {
    const { admin, aiFinal } = await scenario();
    const [cred] = await issueExamCredentials(admin, aiFinal.id);
    const login1 = await authenticateExamCredential(cred.learner.email, cred.code);
    expect(login1.ok).toBe(true);

    await revokeExamCredential(admin, cred.credentialId);

    await expect(authenticateExamCredential(cred.learner.email, cred.code)).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
    if (login1.ok) await expect(validateSessionToken(login1.token)).resolves.toBeNull();
    await expect(revokeExamCredential(admin, cred.credentialId)).rejects.toBeInstanceOf(ConflictError);
    const listed = await listExamCredentials(admin, aiFinal.id);
    expect(listed.find((c) => c.id === cred.credentialId)).toMatchObject({ status: ExamCredentialStatus.REVOKED, state: "REVOKED" });
  });

  it("re-issuing replaces the previous credential", async () => {
    const { admin, aiFinal, aiRahul } = await scenario();
    const [old] = await issueExamCredentials(admin, aiFinal.id, { candidateIds: [aiRahul.id] });
    const [fresh] = await issueExamCredentials(admin, aiFinal.id, { candidateIds: [aiRahul.id] });

    await expect(authenticateExamCredential("rahul@gmail.com", old.code)).resolves.toMatchObject({ ok: false });
    await expect(authenticateExamCredential("rahul@gmail.com", fresh.code)).resolves.toMatchObject({ ok: true });
    expect(await db.examCredential.count({ where: { candidateId: aiRahul.id, status: ExamCredentialStatus.ACTIVE } })).toBe(1);
  });

  it("requires the assessment to be open for sign-in", async () => {
    const { admin, aiFinal } = await scenario();
    const [cred] = await issueExamCredentials(admin, aiFinal.id);
    await db.assessment.update({ where: { id: aiFinal.id }, data: { status: AssessmentStatus.EVALUATION } });

    await expect(authenticateExamCredential(cred.learner.email, cred.code)).resolves.toMatchObject({ ok: false, reason: "assessment_unavailable" });
    await expect(issueExamCredentials(admin, aiFinal.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("disappears with the candidate: an unassigned learner cannot sign in", async () => {
    const { admin, aiFinal, aiAmit } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);
    await removeCandidate(admin, aiFinal.id, aiAmit.id);

    await expect(authenticateExamCredential("amit@gmail.com", codeFor(issued, "amit@gmail.com"))).resolves.toMatchObject({ ok: false, reason: "invalid_credentials" });
  });

  it("never exposes hashes in admin listings, and only admins issue or revoke", async () => {
    const { admin, aiFinal, examiner1 } = await scenario();
    const [cred] = await issueExamCredentials(admin, aiFinal.id);

    const listed = await listExamCredentials(admin, aiFinal.id);
    expect(JSON.stringify(listed)).not.toContain("codeHash");
    expect(listed).toHaveLength(3);
    await expect(issueExamCredentials(examiner1, aiFinal.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeExamCredential(examiner1, cred.credentialId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listExamCredentials(examiner1, aiFinal.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
describe("learner access", () => {
  it("sees only their own candidate row in their exam's assessment", async () => {
    const { admin, aiFinal, aiRahul, aiPriya } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);
    const rahul = await examSession("rahul@gmail.com", codeFor(issued, "rahul@gmail.com"));

    const visible = await listCandidates(rahul, aiFinal.id);
    expect(visible.map((c) => c.id)).toEqual([aiRahul.id]);
    expect(visible[0]).not.toHaveProperty("examiner");
    await expect(getCandidate(rahul, aiFinal.id, aiRahul.id)).resolves.toMatchObject({ id: aiRahul.id });
    await expect(getCandidate(rahul, aiFinal.id, aiPriya.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("gets nothing for an assessment they are not assigned to", async () => {
    const { admin, aiFinal, leadership } = await scenario();
    const issued = await issueExamCredentials(admin, aiFinal.id);
    const priya = await examSession("priya@gmail.com", codeFor(issued, "priya@gmail.com"));

    await expect(listCandidates(priya, leadership.id)).resolves.toEqual([]);
    const leadRahul = (await listCandidates(admin, leadership.id))[0];
    await expect(getCandidate(priya, leadership.id, leadRahul.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("examiner access", () => {
  it("examiner accounts sign in with the normal staff login", async () => {
    await createUser({ email: "examiner1@example.com", role: Role.EXAMINER });
    await expect(login("examiner1@example.com", TEST_PASSWORD)).resolves.toMatchObject({ ok: true, user: { role: Role.EXAMINER } });
  });

  it("can read an assigned candidate", async () => {
    const { examiner1, aiFinal, aiRahul } = await scenario();
    await expect(getCandidate(examiner1, aiFinal.id, aiRahul.id)).resolves.toMatchObject({ id: aiRahul.id, learner: { email: "rahul@gmail.com" } });
    await expect(listCandidates(examiner1, aiFinal.id)).resolves.toHaveLength(1);
  });

  it("cannot read an unassigned candidate or another examiner's candidate", async () => {
    const { examiner1, aiFinal, aiPriya, aiAmit } = await scenario();
    await expect(getCandidate(examiner1, aiFinal.id, aiAmit.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCandidate(examiner1, aiFinal.id, aiPriya.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCandidates(examiner1, aiFinal.id)).map((c) => c.learner.email)).toEqual(["rahul@gmail.com"]);
  });

  it("cannot reach a candidate by manipulating ids in the request", async () => {
    const { examiner1, examiner2, aiFinal, leadership, aiRahul, leadRahul } = await scenario();
    // Right candidate id, wrong assessment id (and vice versa).
    await expect(getCandidate(examiner1, leadership.id, aiRahul.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCandidate(examiner2, aiFinal.id, leadRahul.id)).rejects.toBeInstanceOf(NotFoundError);
    // Made-up id.
    await expect(getCandidate(examiner1, aiFinal.id, "cand_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("has assessment-specific assignments: marking Rahul in AI Final gives nothing in Leadership", async () => {
    const { examiner1, examiner2, aiFinal, leadership, leadRahul } = await scenario();

    await expect(listCandidates(examiner1, leadership.id)).resolves.toEqual([]);
    await expect(getCandidate(examiner1, leadership.id, leadRahul.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCandidate(examiner2, leadership.id, leadRahul.id)).resolves.toMatchObject({ id: leadRahul.id });
    expect((await listExaminerAssessments(examiner1)).map((a) => a.id)).toEqual([aiFinal.id]);
    expect((await listExaminerAssessments(examiner2)).map((a) => [a.name, a.assignedCandidates]).sort()).toEqual([
      ["AI Final Exam", 1],
      ["Leadership Exam", 1],
    ]);
  });

  it("cannot perform admin operations; reviewers see no candidates", async () => {
    const { examiner1, aiFinal, aiAmit } = await scenario();
    await expect(assignExaminer(examiner1, aiFinal.id, [aiAmit.id], examiner1.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignLearnersToAssessment(examiner1, aiFinal.id, [aiAmit.id])).rejects.toBeInstanceOf(ForbiddenError);
    const reviewer = await createActor(Role.REVIEWER);
    await expect(listCandidates(reviewer, aiFinal.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("loses access as soon as the candidate is reassigned", async () => {
    const { admin, examiner1, examiner2, aiFinal, aiRahul } = await scenario();
    await assignExaminer(admin, aiFinal.id, [aiRahul.id], examiner2.id);

    await expect(getCandidate(examiner1, aiFinal.id, aiRahul.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCandidate(examiner2, aiFinal.id, aiRahul.id)).resolves.toMatchObject({ examiner: { id: examiner2.id } });
  });
});

// ---------------------------------------------------------------------------
describe("admin", () => {
  it("sees all learners (optionally by batch) and all examiners", async () => {
    const { admin, course, rahul, priya } = await scenario();
    const batch = await db.batch.create({ data: { code: "B1", name: "Batch 1", courseId: course.id } });
    await expect(addLearnersToBatch(admin, batch.id, [rahul.id, priya.id, rahul.id])).resolves.toBe(2);

    expect((await listLearners(admin)).map((l) => l.email)).toEqual(["amit@gmail.com", "priya@gmail.com", "rahul@gmail.com"]);
    expect((await listLearners(admin, { batchId: batch.id })).map((l) => l.email)).toEqual(["priya@gmail.com", "rahul@gmail.com"]);
    expect(await listExaminers(admin)).toHaveLength(2);
  });

  it("sees every candidate and assignment", async () => {
    const { admin, aiFinal, examiner1, examiner2 } = await scenario();
    const all = await listCandidates(admin, aiFinal.id);
    expect(all.map((c) => [c.learner.email, c.examiner?.id ?? null])).toEqual([
      ["amit@gmail.com", null],
      ["priya@gmail.com", examiner2.id],
      ["rahul@gmail.com", examiner1.id],
    ]);
  });

  it("assigns, reassigns and unassigns candidates to examiners within one assessment", async () => {
    const { admin, aiFinal, examiner1, aiAmit, aiPriya } = await scenario();

    await expect(assignExaminer(admin, aiFinal.id, [aiAmit.id, aiPriya.id], examiner1.id)).resolves.toBe(2);
    expect((await listCandidates(examiner1, aiFinal.id)).map((c) => c.learner.email)).toEqual(["amit@gmail.com", "priya@gmail.com", "rahul@gmail.com"]);

    await assignExaminer(admin, aiFinal.id, [aiAmit.id], null);
    const amit = await getCandidate(admin, aiFinal.id, aiAmit.id);
    expect(amit).toMatchObject({ examiner: null, examinerAssignedAt: null });
    const audit = await db.auditLog.count({ where: { action: AuditAction.EXAMINER_ASSIGNED } });
    expect(audit).toBeGreaterThanOrEqual(5);
  });

  it("rejects assigning to a non-examiner, a disabled examiner or a candidate of another assessment", async () => {
    const { admin, aiFinal, leadership, aiAmit, leadRahul, examiner1 } = await scenario();
    const reviewer = await createActor(Role.REVIEWER);
    await expect(assignExaminer(admin, aiFinal.id, [aiAmit.id], reviewer.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(assignExaminer(admin, aiFinal.id, [leadRahul.id], examiner1.id)).rejects.toBeInstanceOf(NotFoundError);
    await db.user.update({ where: { id: examiner1.id }, data: { status: UserStatus.DISABLED } });
    await expect(assignExaminer(admin, leadership.id, [leadRahul.id], examiner1.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("assigns a whole batch of the assessment's course, skipping existing candidates", async () => {
    const { admin, course, aiFinal, rahul } = await scenario();
    const newcomer = await createLearner(admin, { name: "Neha Gupta", email: "neha@gmail.com" });
    const batch = await db.batch.create({ data: { code: "B2", name: "Batch 2", courseId: course.id } });
    await addLearnersToBatch(admin, batch.id, [rahul.id, newcomer.id]);

    await expect(assignBatchToAssessment(admin, aiFinal.id, batch.id)).resolves.toBe(1);
    expect(await listCandidates(admin, aiFinal.id)).toHaveLength(4);

    const otherCourse = await createCourse();
    const otherBatch = await db.batch.create({ data: { code: "B3", name: "Other", courseId: otherCourse.id } });
    await expect(assignBatchToAssessment(admin, aiFinal.id, otherBatch.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("only assigns learner accounts as candidates", async () => {
    const { admin, aiFinal, examiner1 } = await scenario();
    await expect(assignLearnersToAssessment(admin, aiFinal.id, [examiner1.id])).rejects.toBeInstanceOf(ValidationError);
  });
});
