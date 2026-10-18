import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import type { SessionUser } from "@/server/auth/session";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { getAssessment } from "@/server/services/assessments";
import { addPaperQuestion, addSection, createQuestionPaper } from "@/server/services/question-papers";
import { createReadyPaper, createBatchWithLearners, createCourse, createUser, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * The Assessment Builder's server actions, end to end against assessment_test: session + role
 * check, the assessment services, PostgreSQL, and the paths revalidated for the server pages.
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
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const actions = await import("@/server/actions/assessments");

let admin: SessionUser;
async function signInAs(role: Role): Promise<SessionUser> {
  const u = await createUser({ role, name: `${role} user`, email: `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com` });
  const { token } = await createSession(u.id);
  jar.set(SESSION_COOKIE_NAME, token);
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

beforeEach(async () => {
  jar.clear();
  revalidatePath.mockClear();
  await resetDatabase();
  admin = await signInAs(Role.ADMIN);
});
afterAll(() => db.$disconnect());

const ok = <T,>(r: { ok: boolean; data?: T; error?: string; fieldErrors?: unknown }) => {
  if (!r.ok) throw new Error(`action failed: ${r.error} ${JSON.stringify(r.fieldErrors ?? {})}`);
  return r.data as T;
};
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const signInAgain = async (user: SessionUser) => jar.set(SESSION_COOKIE_NAME, (await createSession(user.id)).token);

/** What the wizard sends after "Basic details" (IST datetime-local strings, as from the inputs). */
const basics = (courseId: string, batchId: string | null, overrides: Record<string, unknown> = {}) => ({
  name: "AI for Leaders Final Exam",
  courseId,
  batchId: batchId ?? "",
  type: "OBJECTIVE",
  description: "End-of-programme assessment.",
  instructions: "Read every question carefully.",
  durationMinutes: "60",
  timingMode: "WINDOW",
  maxAttempts: "1",
  passingMarks: "0",
  negativeMarking: true,
  randomizeQuestions: false,
  randomizeOptions: false,
  allowResume: true,
  showQuestionPalette: true,
  allowMarkForReview: true,
  resultVisibility: "ON_PUBLISH",
  resultDetail: "SCORE",
  proctoringEnabled: false,
  startAt: "2027-01-15T10:00",
  endAt: "2027-01-15T13:00",
  ...overrides,
});

async function world() {
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { name: "AI for Leaders Final Paper" });
  const batch = await createBatchWithLearners(course.id, 3);
  return { course, paper, batch };
}

/** A complete draft built through the actions, ready to publish. */
async function readyDraft() {
  const w = await world();
  const { id } = ok(await actions.saveAssessmentAction(null, basics(w.course.id, w.batch.id)));
  ok(await actions.saveAssessmentAction(id, { paperId: w.paper.id }));
  return { ...w, id };
}

// ---------------------------------------------------------------------------
describe("building an assessment", () => {
  it("creates a DRAFT in PostgreSQL from the basic details and refreshes the pages", async () => {
    const { course, batch } = await world();
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, batch.id)));

    expect(await db.assessment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: "AI for Leaders Final Exam",
      courseId: course.id,
      batchId: batch.id,
      paperId: null,
      type: "OBJECTIVE",
      status: "DRAFT",
      createdById: admin.id,
      description: "End-of-programme assessment.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/assessments");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/assessments/${id}`);

    expect(await actions.saveAssessmentAction(null, basics(course.id, batch.id, { name: "AI", courseId: "" }))).toMatchObject({
      ok: false,
      fieldErrors: { name: expect.any(Array), courseId: expect.any(Array) },
    });
    expect(await db.assessment.count()).toBe(1);
  });

  it("selects a real question paper and copies its questions", async () => {
    const { course, paper, batch } = await world();
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, batch.id)));
    ok(await actions.saveAssessmentAction(id, { paperId: paper.id }));

    const a = await getAssessment(admin, id);
    expect(a.paper).toMatchObject({ id: paper.id, version: 1 });
    expect(a.questions.map((q) => q.questionId)).toEqual(paper.questionIds);
    expect(await db.assessmentQuestion.count({ where: { assessmentId: id, paperQuestionId: { not: null } } })).toBe(2);
  });

  it("a just-saved paper is selectable at once — no approval; incomplete and other-course papers are refused", async () => {
    const { course, batch } = await world();
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, batch.id)));
    const incomplete = await createQuestionPaper(admin, { name: "Incomplete", courseId: course.id });
    await addSection(admin, incomplete.id, { title: "Empty section" });
    const other = await createReadyPaper(admin, (await createCourse()).id, { name: "Other course paper" });
    expect(await actions.saveAssessmentAction(id, { paperId: incomplete.id })).toMatchObject({ ok: false, fieldErrors: { paperId: ["This question paper is incomplete: “Empty section” has no questions."] } });
    expect(await actions.saveAssessmentAction(id, { paperId: other.id })).toMatchObject({ ok: false, fieldErrors: { paperId: ["This question paper belongs to a different course"] } });
    expect(await actions.saveAssessmentAction(id, { paperId: "missing" })).toMatchObject({ ok: false });
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).paperId).toBeNull();
    expect(await db.assessmentQuestion.count()).toBe(0);

    // Saved a moment ago, never reviewed: usable straight away.
    const saved = await createQuestionPaper(admin, { name: "Saved just now", courseId: course.id });
    const s = await addSection(admin, saved.id, { title: "A" });
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "Fresh Q" }));
    ok(await actions.saveAssessmentAction(id, { paperId: saved.id }));
    expect(await db.assessmentQuestion.count({ where: { assessmentId: id } })).toBe(1);
  });

  it("saves the configuration", async () => {
    const { id } = await readyDraft();
    ok(
      await actions.saveAssessmentAction(id, {
        durationMinutes: "90",
        timingMode: "FULL_DURATION",
        maxAttempts: "2",
        passingMarks: "2.5",
        negativeMarking: false,
        randomizeQuestions: true,
        randomizeOptions: true,
        allowResume: false,
        showQuestionPalette: false,
        allowMarkForReview: false,
        resultVisibility: "IMMEDIATE",
        resultDetail: "SCORE_AND_ANSWERS",
        proctoringEnabled: true,
      }),
    );
    const a = await getAssessment(admin, id);
    expect(a).toMatchObject({
      durationMinutes: 90,
      maxAttempts: 2,
      passingMarks: 2.5,
      resultVisibility: "IMMEDIATE",
      resultDetail: "SCORE_AND_ANSWERS",
      proctoringEnabled: true,
      settings: { timingMode: "FULL_DURATION", negativeMarking: false, randomizeQuestions: true, randomizeOptions: true, allowResume: false, showQuestionPalette: false, allowMarkForReview: false },
    });

    // Field and cross-field rules come from the service.
    expect(await actions.saveAssessmentAction(id, { maxAttempts: "0", durationMinutes: "0" })).toMatchObject({ ok: false, fieldErrors: { maxAttempts: expect.any(Array), durationMinutes: expect.any(Array) } });
    expect(await actions.saveAssessmentAction(id, { type: "MIXED" })).toMatchObject({ ok: false, fieldErrors: { resultVisibility: ["Immediate results are only possible for objective assessments"] } });
    expect((await getAssessment(admin, id)).maxAttempts).toBe(2);
  });

  it("saves the schedule entered in IST and stores it in UTC", async () => {
    const { id } = await readyDraft();
    ok(await actions.saveAssessmentAction(id, { startAt: "2027-02-01T09:30", endAt: "2027-02-01T12:00" }));
    const row = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(row.startAt.toISOString()).toBe("2027-02-01T04:00:00.000Z");
    expect(row.endAt.toISOString()).toBe("2027-02-01T06:30:00.000Z");

    expect(await actions.saveAssessmentAction(id, { startAt: "2027-02-01T12:00", endAt: "2027-02-01T09:00" })).toMatchObject({ ok: false, fieldErrors: { endAt: ["End time must be after the start time"] } });
    expect(await actions.saveAssessmentAction(id, { startAt: "2027-02-01T09:00", endAt: "2027-02-01T09:30" })).toMatchObject({ ok: false, fieldErrors: { endAt: [expect.stringMatching(/at least as long as the duration/)] } });
    expect(await actions.saveAssessmentAction(id, { startAt: "2027-02-31T09:00" })).toMatchObject({ ok: false, fieldErrors: { startAt: expect.any(Array) } });
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).startAt.toISOString()).toBe("2027-02-01T04:00:00.000Z");
  });

  it("selects a real batch; inactive and other-course batches are refused", async () => {
    const { course } = await world();
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, null)));
    const live = await createBatchWithLearners(course.id, 2);
    const inactive = await createBatchWithLearners(course.id, 1);
    await db.batch.update({ where: { id: inactive.id }, data: { isActive: false } });
    const elsewhere = await createBatchWithLearners((await createCourse()).id, 1);

    ok(await actions.saveAssessmentAction(id, { batchId: live.id }));
    expect((await getAssessment(admin, id)).batch).toMatchObject({ id: live.id, learnerCount: 2, isActive: true });
    expect(await actions.saveAssessmentAction(id, { batchId: inactive.id })).toMatchObject({ ok: false, fieldErrors: { batchId: ["This batch is inactive"] } });
    expect(await actions.saveAssessmentAction(id, { batchId: elsewhere.id })).toMatchObject({ ok: false, fieldErrors: { batchId: ["This batch belongs to a different course"] } });
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).batchId).toBe(live.id);
  });

  it("edits an existing draft, and a fresh read returns every saved value", async () => {
    const { id, paper, batch } = await readyDraft();
    ok(await actions.saveAssessmentAction(id, basics((await db.assessment.findUniqueOrThrow({ where: { id } })).courseId, batch.id, { name: "AI for Leaders — Final (2027)", description: "", instructions: "No calculators.", passingMarks: "1" })));

    const fresh = await getAssessment(admin, id);
    expect(fresh).toMatchObject({
      name: "AI for Leaders — Final (2027)",
      description: null,
      instructions: "No calculators.",
      passingMarks: 1,
      paper: { id: paper.id },
      batch: { id: batch.id },
      status: "DRAFT",
      publishIssues: [],
    });
    expect(await db.auditLog.count({ where: { entityId: id, action: "assessment.updated" } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("review & publish", () => {
  it("publishes through the lifecycle and assigns the batch's learners as candidates", async () => {
    const { id, batch } = await readyDraft();
    const { candidatesAdded } = ok(await actions.publishAssessmentAction(id));
    expect(candidatesAdded).toBe(3);

    const row = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "SCHEDULED", scheduledAt: expect.any(Date) });
    const members = await db.batchMember.findMany({ where: { batchId: batch.id }, select: { userId: true } });
    const candidates = await db.assessmentCandidate.findMany({ where: { assessmentId: id }, select: { learnerId: true } });
    expect(candidates.map((c) => c.learnerId).sort()).toEqual(members.map((m) => m.userId).sort());
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/assessments/${id}`);
  });

  it("refuses to publish an incomplete draft, with every reason, and changes nothing", async () => {
    const { course } = await world();
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, null)));
    const result = await actions.publishAssessmentAction(id);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toMatch(/Select a question paper\. Select the batch/);
    expect(await db.assessment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DRAFT", scheduledAt: null });
    expect(await db.assessmentCandidate.count()).toBe(0);
  });

  it("refuses a start time in the past and a type that doesn't fit the paper", async () => {
    const { course, batch } = await world();
    const mixed = await createReadyPaper(admin, course.id, { name: "Mixed", sections: [{ questions: [mcqSingle({ text: "M1" }), shortAnswer({ text: "S1" })] }] });
    const { id } = ok(await actions.saveAssessmentAction(null, basics(course.id, batch.id, { startAt: "2020-01-01T10:00", endAt: "2020-01-01T13:00" })));
    ok(await actions.saveAssessmentAction(id, { paperId: mixed.id }));
    const result = await actions.publishAssessmentAction(id);
    expect(result.ok ? "" : result.error).toMatch(/Start time must be in the future/);
    expect(result.ok ? "" : result.error).toMatch(/do not match the objective assessment type/);
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  it("runs the allowed transitions: publish → back to draft → publish; archive a draft", async () => {
    const { id } = await readyDraft();
    ok(await actions.publishAssessmentAction(id));

    // Scheduled: the paper, batch and rules are locked; cosmetic fields and the window are not.
    expect(await actions.saveAssessmentAction(id, { maxAttempts: "3" })).toMatchObject({ ok: false, error: expect.stringMatching(/Maximum attempts cannot be changed while the assessment is scheduled/) });
    ok(await actions.saveAssessmentAction(id, { name: "Renamed while scheduled" }));

    ok(await actions.moveAssessmentToDraftAction(id));
    expect(await db.assessment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DRAFT", scheduledAt: null, name: "Renamed while scheduled" });
    ok(await actions.publishAssessmentAction(id));
    expect(await db.assessmentCandidate.count({ where: { assessmentId: id } })).toBe(3);

    const other = await readyDraft();
    ok(await actions.archiveAssessmentAction(other.id));
    expect(await db.assessment.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: "ARCHIVED", archivedAt: expect.any(Date) });
  });

  it("rejects transitions the lifecycle doesn't allow", async () => {
    const { id } = await readyDraft();
    expect(await actions.moveAssessmentToDraftAction(id)).toMatchObject({ ok: false, error: "Cannot move from Draft to Draft manually." });
    ok(await actions.publishAssessmentAction(id));
    expect(await actions.publishAssessmentAction(id)).toMatchObject({ ok: false, error: "Cannot move from Scheduled to Scheduled manually." });
    expect(await actions.archiveAssessmentAction(id)).toMatchObject({ ok: false, error: "Cannot move from Scheduled to Archived manually." });

    const archived = await readyDraft();
    ok(await actions.archiveAssessmentAction(archived.id));
    expect(await actions.publishAssessmentAction(archived.id)).toMatchObject({ ok: false });
    expect(await actions.saveAssessmentAction(archived.id, { name: "Edit archived" })).toMatchObject({ ok: false });
    expect(await actions.publishAssessmentAction("missing")).toMatchObject({ ok: false, error: "Assessment not found." });
  });
});

// ---------------------------------------------------------------------------
describe("access control", () => {
  it("only admins can create, edit, publish or change the status of assessments", async () => {
    const { id, course, batch } = await readyDraft();
    const attempts = () => [
      actions.saveAssessmentAction(null, basics(course.id, batch.id, { name: "Intruder" })),
      actions.saveAssessmentAction(id, { name: "Hijacked" }),
      actions.publishAssessmentAction(id),
      actions.moveAssessmentToDraftAction(id),
      actions.archiveAssessmentAction(id),
    ];

    for (const role of [Role.REVIEWER, Role.EXAMINER]) {
      await signInAs(role);
      for (const call of attempts()) expect(await redirectOf(call)).toBe("/forbidden");
    }
    // Learners have no staff session (an exam credential is required), so they are sent to log in.
    await signInAs(Role.LEARNER);
    for (const call of attempts()) expect(await redirectOf(call)).toBe("/login");
    jar.clear();
    for (const call of attempts()) expect(await redirectOf(call)).toBe("/login");

    expect(await db.assessment.count()).toBe(1);
    expect(await db.assessment.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "AI for Leaders Final Exam", status: "DRAFT" });
    expect(await db.assessmentCandidate.count()).toBe(0);

    await signInAgain(admin);
    ok(await actions.saveAssessmentAction(id, { name: "Still the admin's" }));
  });
});
