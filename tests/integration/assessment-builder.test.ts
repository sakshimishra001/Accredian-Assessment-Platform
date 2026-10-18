import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  addQuestionsToAssessment,
  createAssessment,
  getAssessment,
  listAssessmentLearners,
  listAssessments,
  publishAssessment,
  publishAssessmentForBatch,
  syncTimeBasedStatuses,
  transitionAssessment,
  updateAssessment,
} from "@/server/services/assessments";
import { addPaperGroup, addPaperQuestion, addSection, createPaperRevision, createQuestionPaper, getQuestionPaper, updatePaperQuestion } from "@/server/services/question-papers";
import { assignLearnersToAssessment } from "@/server/services/candidates";
import { createQuestion, updateQuestion } from "@/server/services/questions";
import {
  createActor,
  createReadyPaper,
  createBatchWithLearners,
  createCourse,
  createUser,
  hoursFromNow,
  mcqSingle,
  resetDatabase,
  shortAnswer,
} from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const expectError = (p: Promise<unknown>, type: new (...args: never[]) => Error) => expect(p).rejects.toBeInstanceOf(type);

/** Basic details in the shape the builder form submits (IST datetime-local strings). */
const details = (courseId: string, overrides: Record<string, unknown> = {}) => ({
  name: "AI for Leaders Final Exam",
  description: "End-of-programme assessment.",
  instructions: "Read every question carefully.",
  courseId,
  type: "OBJECTIVE",
  durationMinutes: 60,
  startAt: "2027-01-15T10:00",
  endAt: "2027-01-15T12:00",
  passingMarks: 1,
  ...overrides,
});

async function world() {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { name: "AI for Leaders Final Paper" });
  const batch = await createBatchWithLearners(course.id, 3);
  return { admin, course, paper, batch };
}

/**
 * A complete paper of the course carrying a legacy review status (papers no longer go through
 * review; rows created before still hold DRAFT / IN_REVIEW / APPROVED, which no longer matter).
 */
async function paperWithLegacyStatus(admin: SessionUser, courseId: string, status: "DRAFT" | "IN_REVIEW" | "APPROVED") {
  const paper = await createQuestionPaper(admin, { name: `Paper ${status}`, courseId });
  const s = await addSection(admin, paper.id, { title: "A" });
  await addPaperQuestion(admin, s.id, mcqSingle({ text: `Q for ${status}` }));
  await db.questionPaper.update({ where: { id: paper.id }, data: { status, ...(status === "IN_REVIEW" ? { submittedAt: new Date() } : {}) } });
  return paper.id;
}

// ---------------------------------------------------------------------------
describe("assessment creation", () => {
  it("admin creates a DRAFT with paper, batch, instructions and default configuration", async () => {
    const { admin, course, paper, batch } = await world();

    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id, status: "ACTIVE" }));

    const a = await getAssessment(admin, created.id);
    expect(a).toMatchObject({
      status: "DRAFT",
      name: "AI for Leaders Final Exam",
      instructions: "Read every question carefully.",
      course: { id: course.id },
      paper: { id: paper.id, version: 1 },
      batch: { id: batch.id, learnerCount: 3 },
      maxAttempts: 1,
      resultVisibility: "ON_PUBLISH",
      resultDetail: "SCORE",
      createdBy: { name: "ADMIN user" },
      settings: { timingMode: "WINDOW", randomizeQuestions: false, randomizeOptions: false, allowResume: true, showQuestionPalette: true, allowMarkForReview: true, negativeMarking: true },
    });
    expect(a.createdAt).toBeInstanceOf(Date);
  });

  it("validates required fields and rejects invalid data", async () => {
    const { admin, course } = await world();
    for (const missing of ["name", "courseId", "type", "durationMinutes", "startAt", "endAt", "passingMarks"]) {
      const input: Record<string, unknown> = details(course.id);
      delete input[missing];
      await expect(createAssessment(admin, input)).rejects.toMatchObject({ fieldErrors: { [missing]: expect.any(Array) } });
    }
    await expectError(createAssessment(admin, details(course.id, { name: "AI" })), ValidationError);
    await expectError(createAssessment(admin, details(course.id, { type: "ESSAY" })), ValidationError);
    expect(await db.assessment.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("question paper selection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a saved paper and freezes its questions in paper order", async () => {
    const { admin, course, batch } = await world();
    const paper = await createReadyPaper(admin, course.id, {
      sections: [
        { title: "Section A", questions: [mcqSingle({ text: "A1" }), mcqSingle({ text: "A2" })] },
        { title: "Section B", questions: [mcqSingle({ text: "B1" })] },
      ],
    });

    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));

    const a = await getAssessment(admin, created.id);
    expect(a.questions.map((q) => [q.content.text, q.paperSection?.title])).toEqual([
      ["A1", "Section A"],
      ["A2", "Section A"],
      ["B1", "Section B"],
    ]);
    expect(a.totals).toMatchObject({ questionCount: 3, totalMarks: 6 });
  });

  it.each(["DRAFT", "IN_REVIEW", "APPROVED"] as const)("accepts a complete paper whatever its legacy status (%s) — no approval needed", async (status) => {
    const { admin, course, batch } = await world();
    const paperId = await paperWithLegacyStatus(admin, course.id, status);
    const created = await createAssessment(admin, details(course.id, { paperId, batchId: batch.id }));
    expect((await getAssessment(admin, created.id)).questions.map((q) => q.content.text)).toEqual([`Q for ${status}`]);
    const draft = await createAssessment(admin, details(course.id, { batchId: batch.id }));
    await updateAssessment(admin, draft.id, { paperId });
  });

  it("refuses a paper that is genuinely unusable (incomplete)", async () => {
    const { admin, course, batch } = await world();
    const paper = await createQuestionPaper(admin, { name: "Half done", courseId: course.id });
    const s = await addSection(admin, paper.id, { title: "A" });
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "No marks", marks: 0 }));
    await expect(createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }))).rejects.toMatchObject({
      fieldErrors: { paperId: ["This question paper is incomplete: Q1 has no marks."] },
    });
    const draft = await createAssessment(admin, details(course.id, { batchId: batch.id }));
    await expectError(updateAssessment(admin, draft.id, { paperId: paper.id }), ValidationError);
  });

  /**
   * The shape of the paper that timed out: 4 sections, 15 questions (17 paper items — two of them
   * case studies holding sub-questions), different marks, standalone questions after a case.
   */
  async function largePaper(admin: SessionUser, courseId: string) {
    const paper = await createQuestionPaper(admin, { name: "abc", courseId });
    const expected: { text: string; section: string; marks: number; caseText: string | null }[] = [];
    const add = async (sectionId: string, section: string, text: string, marks: number, parent?: { id: string; text: string }) => {
      await addPaperQuestion(admin, sectionId, (text.startsWith("W") ? shortAnswer : mcqSingle)({ text, marks }), parent ? { parentId: parent.id } : {});
      expected.push({ text, section, marks, caseText: parent?.text ?? null });
    };
    const a = await addSection(admin, paper.id, { title: "A — Basics" });
    for (let i = 1; i <= 4; i++) await add(a.id, "A — Basics", `A${i}`, i);
    const b = await addSection(admin, paper.id, { title: "B — Case" });
    const caseB = await addPaperGroup(admin, b.id, { groupType: "CASE_STUDY", text: "Airline delays", passage: "An airline wants to cut delays…" });
    for (let i = 1; i <= 3; i++) await add(b.id, "B — Case", `W-B${i}`, 5, { id: caseB.id, text: "Airline delays" });
    await add(b.id, "B — Case", "B-after-case", 2);
    const c = await addSection(admin, paper.id, { title: "C — Mixed" });
    await add(c.id, "C — Mixed", "C1", 1.5);
    const caseC = await addPaperGroup(admin, c.id, { groupType: "COMPREHENSION", text: "Retail data", passage: "Sales by region…" });
    for (let i = 1; i <= 2; i++) await add(c.id, "C — Mixed", `W-C${i}`, 4, { id: caseC.id, text: "Retail data" });
    await add(c.id, "C — Mixed", "C2", 2);
    const d = await addSection(admin, paper.id, { title: "D — Written" });
    for (let i = 1; i <= 3; i++) await add(d.id, "D — Written", `W-D${i}`, 10);
    return { paperId: paper.id, expected };
  }

  /** The assessment's copied questions in order, with their section, case and marks (via the paper links). */
  const copied = (assessmentId: string) =>
    db.assessmentQuestion
      .findMany({
        where: { assessmentId },
        orderBy: { position: "asc" },
        select: { position: true, questionId: true, marks: true, snapshot: true, paperQuestion: { select: { section: { select: { title: true } }, parent: { select: { snapshot: true } } } } },
      })
      .then((rows) =>
        rows.map((r) => ({
          position: r.position,
          questionId: r.questionId,
          text: (r.snapshot as { text: string }).text,
          section: r.paperQuestion?.section.title,
          marks: r.marks.toNumber(),
          caseText: (r.paperQuestion?.parent?.snapshot as { text: string } | undefined)?.text ?? null,
        })),
      );

  it("1–7/10: a 15-question, 4-section paper with case studies is copied completely and exactly, once", async () => {
    const { admin, course, batch } = await world();
    const { paperId, expected } = await largePaper(admin, course.id);
    expect(expected).toHaveLength(15);

    // Selecting it on an existing draft (the path that timed out) and creating with it.
    const draft = await createAssessment(admin, details(course.id, { type: "MIXED", batchId: batch.id }));
    await updateAssessment(admin, draft.id, { paperId });
    const created = await createAssessment(admin, details(course.id, { type: "MIXED", paperId, batchId: batch.id }));

    for (const id of [draft.id, created.id]) {
      const rows = await copied(id);
      expect(rows.map(({ text, section, marks, caseText }) => ({ text, section, marks, caseText }))).toEqual(expected);
      expect(rows.map((r) => r.position)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      expect(new Set(rows.map((r) => r.questionId)).size).toBe(15);
      const a = await getAssessment(admin, id);
      expect(a.paper).toMatchObject({ id: paperId });
      expect(a.totals).toMatchObject({ questionCount: 15, totalMarks: expected.reduce((m, q) => m + q.marks, 0) });
    }
  });

  it("9: saving again, or switching papers and back, never duplicates or loses questions", async () => {
    const { admin, course, paper, batch } = await world();
    const { paperId } = await largePaper(admin, course.id);
    const a = await createAssessment(admin, details(course.id, { type: "MIXED", batchId: batch.id }));
    await updateAssessment(admin, a.id, { paperId });
    await updateAssessment(admin, a.id, { paperId }); // same paper again: no change
    await updateAssessment(admin, a.id, { name: "Renamed", paperId });
    expect(await db.assessmentQuestion.count({ where: { assessmentId: a.id } })).toBe(15);
    await updateAssessment(admin, a.id, { paperId: paper.id });
    expect(await db.assessmentQuestion.count({ where: { assessmentId: a.id } })).toBe(2);
    await updateAssessment(admin, a.id, { paperId });
    expect((await copied(a.id)).map((r) => r.position)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(await db.assessmentQuestion.count()).toBe(15);
  });

  /** Make the database fail at the moment the copied questions are inserted (inside the save's transaction). */
  function failQuestionInsert() {
    const original = db.$transaction.bind(db) as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    return vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
      original(
        (tx) =>
          fn(
            new Proxy(tx as object, {
              get(target, prop) {
                const value = Reflect.get(target, prop);
                if (prop !== "assessmentQuestion") return value;
                return new Proxy(value as object, {
                  get: (t, p) =>
                    p === "createMany"
                      ? () => Promise.reject(new Error("connection lost"))
                      : typeof Reflect.get(t, p) === "function"
                        ? (Reflect.get(t, p) as (...a: unknown[]) => unknown).bind(t)
                        : Reflect.get(t, p),
                });
              },
            }),
          ),
        opts,
      )) as never);
  }

  it("8: if copying fails part-way, nothing is saved — no partial assessment, no orphan questions", async () => {
    const { admin, course, paper, batch } = await world();
    const { paperId } = await largePaper(admin, course.id);
    const a = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    const before = await copied(a.id);
    failQuestionInsert();

    await expect(createAssessment(admin, details(course.id, { name: "Never saved", type: "MIXED", paperId, batchId: batch.id }))).rejects.toThrow("connection lost");
    expect(await db.assessment.count({ where: { name: "Never saved" } })).toBe(0);

    await expect(updateAssessment(admin, a.id, { type: "MIXED", paperId })).rejects.toThrow("connection lost");
    // The update rolled back as a whole: still the old paper, type and questions.
    expect(await db.assessment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ paperId: paper.id, type: "OBJECTIVE" });
    expect(await copied(a.id)).toEqual(before);
    expect(await db.assessmentQuestion.count()).toBe(2);
  });

  it("rejects a missing paper; any complete paper can be used, whatever its course", async () => {
    const { admin, course, batch } = await world();
    await expect(createAssessment(admin, details(course.id, { paperId: "nope" }))).rejects.toMatchObject({ fieldErrors: { paperId: ["Question paper not found"] } });
    const other = await createCourse();
    const foreign = await createReadyPaper(admin, other.id);
    const a = await createAssessment(admin, details(course.id, { paperId: foreign.id, batchId: batch.id }));
    expect(a).toMatchObject({ paperId: foreign.id, courseId: course.id });
  });

  it("I: no course is chosen — an assessment is created from name, batch and paper; its course follows the batch", async () => {
    const { admin, paper } = await world();
    const other = await createCourse();
    const batch = await createBatchWithLearners(other.id, 1);
    const withoutCourse = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "courseId"));
    const a = await createAssessment(admin, withoutCourse(details("unused", { paperId: paper.id, batchId: batch.id })));
    expect(a.courseId).toBe(other.id);
    // Without a batch (and without the legacy course input) the batch is what's asked for.
    await expect(createAssessment(admin, withoutCourse(details("unused", { paperId: paper.id })))).rejects.toMatchObject({ fieldErrors: { batchId: ["Choose the batch that will take this assessment"] } });
    // Changing the batch moves the assessment to that batch's course; the course itself isn't editable.
    const again = await createBatchWithLearners((await createCourse()).id, 1);
    await updateAssessment(admin, a.id, { batchId: again.id });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: a.id } })).courseId).toBe((await db.batch.findUniqueOrThrow({ where: { id: again.id } })).courseId);
    await updateAssessment(admin, a.id, { courseId: other.id });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: a.id } })).courseId).not.toBe(other.id);
  });

  it("preserves the paper version: bank edits and new paper versions don't change the assessment", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    await publishAssessment(admin, created.id);
    const before = await getAssessment(admin, created.id);

    // Edit the bank question and publish a v2 of the paper with different wording.
    await updateQuestion(admin, paper.questionIds[0], mcqSingle({ text: "Edited in the bank" }));
    const v2 = await createPaperRevision(admin, paper.id);
    const v2Detail = await getQuestionPaper(admin, v2.id);
    await updatePaperQuestion(admin, v2Detail.sections[0].items[0].id, mcqSingle({ text: "Q1 — v2 wording" }));

    const after = await getAssessment(admin, created.id);
    expect(after.paper).toMatchObject({ id: paper.id, version: 1 });
    expect(after.questions.map((q) => q.content)).toEqual(before.questions.map((q) => q.content));
    expect(after.questions[0].content.text).toBe("Q1");
  });

  it("switching to a newer version in a draft replaces the questions", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    const v2 = await createPaperRevision(admin, paper.id);
    const s = await addSection(admin, v2.id, { title: "Extra" });
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "New in v2" }));

    await updateAssessment(admin, created.id, { paperId: v2.id });

    const a = await getAssessment(admin, created.id);
    expect(a.paper).toMatchObject({ id: v2.id, version: 2 });
    expect(a.questions.map((q) => q.content.text)).toEqual(["Q1", "Q2", "New in v2"]);
  });

  it("doesn't mix individually picked bank questions with a paper", async () => {
    const { admin, course, paper, batch } = await world();
    const withPaper = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    const bankQ = await createQuestion(admin, mcqSingle({ text: "Loose bank question" }));
    await expectError(addQuestionsToAssessment(admin, withPaper.id, [bankQ.id]), ConflictError);

    const picked = await createAssessment(admin, details(course.id));
    await addQuestionsToAssessment(admin, picked.id, [bankQ.id]);
    await expectError(updateAssessment(admin, picked.id, { paperId: paper.id }), ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("batch selection", () => {
  it("associates the assessment with the batch and derives learners from it", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));

    expect((await getAssessment(admin, created.id)).batch).toMatchObject({ id: batch.id, name: batch.name });
    const learners = await listAssessmentLearners(admin, created.id);
    expect(learners).toHaveLength(3);

    // Live, not copied: membership changes and disabled accounts are reflected.
    const newcomer = await createUser({ role: Role.LEARNER, name: "Zara Newcomer" });
    await db.batchMember.create({ data: { batchId: batch.id, userId: newcomer.id } });
    await db.user.update({ where: { id: learners[0].id }, data: { status: UserStatus.DISABLED } });
    const now = await listAssessmentLearners(admin, created.id);
    expect(now.map((l) => l.name)).toEqual(["Learner 2", "Learner 3", "Zara Newcomer"]);
    expect(await db.assessmentCandidate.count()).toBe(0);
  });

  it("rejects a missing or inactive batch; a batch of any course can be chosen", async () => {
    const { admin, course, paper } = await world();
    await expect(createAssessment(admin, details(course.id, { paperId: paper.id, batchId: "nope" }))).rejects.toMatchObject({ fieldErrors: { batchId: ["Batch not found"] } });
    const inactive = await db.batch.create({ data: { name: "Old batch", courseId: course.id, isActive: false } });
    await expect(createAssessment(admin, details(course.id, { batchId: inactive.id }))).rejects.toMatchObject({ fieldErrors: { batchId: ["This batch is inactive"] } });
    const other = await createCourse();
    const foreign = await createBatchWithLearners(other.id, 1);
    expect(await createAssessment(admin, details(course.id, { batchId: foreign.id }))).toMatchObject({ batchId: foreign.id, courseId: other.id });
  });
});

// ---------------------------------------------------------------------------
describe("configuration", () => {
  it("defaults to one attempt and accepts a custom count and settings", async () => {
    const { admin, course } = await world();
    const one = await createAssessment(admin, details(course.id));
    expect(one.maxAttempts).toBe(1);

    const custom = await createAssessment(
      admin,
      details(course.id, {
        name: "Practice quiz",
        maxAttempts: 3,
        timingMode: "FULL_DURATION",
        randomizeQuestions: true,
        randomizeOptions: "on",
        allowResume: false,
        showQuestionPalette: "false",
        allowMarkForReview: false,
        negativeMarking: false,
        resultDetail: "FULL_FEEDBACK",
      }),
    );
    expect(custom).toMatchObject({
      maxAttempts: 3,
      timingMode: "FULL_DURATION",
      randomizeQuestions: true,
      randomizeOptions: true,
      allowResume: false,
      showQuestionPalette: false,
      allowMarkForReview: false,
      negativeMarking: false,
      resultDetail: "FULL_FEEDBACK",
    });
  });

  it("rejects invalid duration, attempts and options", async () => {
    const { admin, course } = await world();
    for (const bad of [{ durationMinutes: 0 }, { durationMinutes: 601 }, { durationMinutes: 12.5 }, { maxAttempts: 0 }, { maxAttempts: 11 }, { timingMode: "SOMETIMES" }, { resultDetail: "EVERYTHING" }]) {
      await expectError(createAssessment(admin, details(course.id, bad)), ValidationError);
    }
    // Existing rule: immediate results only for objective assessments.
    await expectError(createAssessment(admin, details(course.id, { type: "MIXED", resultVisibility: "IMMEDIATE" })), ValidationError);
  });
});

// ---------------------------------------------------------------------------
describe("schedule", () => {
  it("accepts a valid window entered in IST and stores it in UTC", async () => {
    const { admin, course } = await world();
    const created = await createAssessment(admin, details(course.id));
    const a = await getAssessment(admin, created.id);
    expect(a.startAt.toISOString()).toBe("2027-01-15T04:30:00.000Z");
    expect(a.endAt.toISOString()).toBe("2027-01-15T06:30:00.000Z");
    expect(a.timeZone).toBe("Asia/Kolkata");
  });

  it("rejects end before start, impossible dates and a window shorter than the duration", async () => {
    const { admin, course } = await world();
    await expect(createAssessment(admin, details(course.id, { endAt: "2027-01-15T09:00" }))).rejects.toMatchObject({ fieldErrors: { endAt: ["End time must be after the start time"] } });
    await expect(createAssessment(admin, details(course.id, { startAt: "2027-13-40T10:00" }))).rejects.toMatchObject({ fieldErrors: { startAt: expect.any(Array) } });
    await expect(createAssessment(admin, details(course.id, { startAt: "next tuesday" }))).rejects.toMatchObject({ fieldErrors: { startAt: expect.any(Array) } });
    await expect(createAssessment(admin, details(course.id, { endAt: "2027-01-15T10:30" }))).rejects.toMatchObject({ fieldErrors: { endAt: [expect.stringMatching(/at least as long as the duration/)] } });
  });
});

// ---------------------------------------------------------------------------
describe("lifecycle", () => {
  it("publishes, then opens and closes by the server clock", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(24), endAt: hoursFromNow(26) }));

    await publishAssessment(admin, created.id);
    expect((await getAssessment(admin, created.id)).status).toBe("SCHEDULED");
    expect((await getAssessment(admin, created.id, hoursFromNow(25))).status).toBe("ACTIVE");
    await syncTimeBasedStatuses(hoursFromNow(27));
    await transitionAssessment(admin, created.id, "RESULT_READY", hoursFromNow(27));
    await transitionAssessment(admin, created.id, "PUBLISHED", hoursFromNow(27));
    expect((await db.assessment.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("PUBLISHED");
  });

  it("rejects transitions the lifecycle doesn't allow", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    for (const to of ["ACTIVE", "ENDED", "RESULT_READY", "PUBLISHED"] as const) await expectError(transitionAssessment(admin, created.id, to), ConflictError);
  });

  it("a draft is fully editable; once published the paper, batch and rules are locked", async () => {
    const { admin, course, paper, batch } = await world();
    const otherBatch = await createBatchWithLearners(course.id, 1);
    const otherPaper = await createReadyPaper(admin, course.id, { name: "Alternative paper", sections: [{ questions: [mcqSingle({ text: "Alt" })] }] });
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));

    await updateAssessment(admin, created.id, { batchId: otherBatch.id, paperId: otherPaper.id, maxAttempts: 2, randomizeQuestions: true });
    await updateAssessment(admin, created.id, { batchId: batch.id, paperId: paper.id });
    await publishAssessment(admin, created.id);

    for (const change of [{ paperId: otherPaper.id }, { batchId: otherBatch.id }, { maxAttempts: 3 }, { randomizeOptions: true }, { durationMinutes: 30 }]) {
      await expectError(updateAssessment(admin, created.id, change), ConflictError);
    }
    await updateAssessment(admin, created.id, { name: "AI for Leaders Final Exam (Sept)", instructions: "Updated instructions." });
    expect(await getAssessment(admin, created.id)).toMatchObject({ name: "AI for Leaders Final Exam (Sept)", maxAttempts: 2, settings: { randomizeQuestions: true } });
  });
});

// ---------------------------------------------------------------------------
describe("review & publish", () => {
  it("won't publish an incomplete assessment and lists what's missing", async () => {
    const { admin, course } = await world();
    const created = await createAssessment(admin, details(course.id, { startAt: hoursFromNow(-2), endAt: hoursFromNow(4) }));

    const a = await getAssessment(admin, created.id);
    expect(a.publishIssues).toEqual([
      "Select a question paper.",
      "Select the batch that will take this assessment.",
      "Add at least one question.",
      "Passing marks (1) exceed total marks (0).",
      "Start time must be in the future.",
    ]);
    await expect(publishAssessment(admin, created.id)).rejects.toThrow(/Select a question paper\. Select the batch/);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("DRAFT");
  });

  it("won't publish with an empty or deactivated batch, or a type that doesn't fit the paper", async () => {
    const { admin, course, paper } = await world();
    const empty = await createBatchWithLearners(course.id, 0);
    const a = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: empty.id }));
    await expect(publishAssessment(admin, a.id)).rejects.toThrow(/no active learners/);

    const full = await createBatchWithLearners(course.id, 2);
    await updateAssessment(admin, a.id, { batchId: full.id });
    await db.batch.update({ where: { id: full.id }, data: { isActive: false } });
    await expect(publishAssessment(admin, a.id)).rejects.toThrow(/batch is inactive/);

    const mixedPaper = await createReadyPaper(admin, course.id, { name: "Mixed", sections: [{ questions: [mcqSingle({ text: "M1" }), shortAnswer({ text: "S1" })] }] });
    const live = await createBatchWithLearners(course.id, 1);
    const objective = await createAssessment(admin, details(course.id, { name: "Objective only", paperId: mixedPaper.id, batchId: live.id }));
    await expect(publishAssessment(admin, objective.id)).rejects.toThrow(/do not match the objective assessment type/);
  });

  it("publishes a complete assessment that references the right paper version and batch", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    expect((await getAssessment(admin, created.id)).publishIssues).toEqual([]);

    await publishAssessment(admin, created.id);

    const a = await getAssessment(admin, created.id);
    expect(a).toMatchObject({ status: "SCHEDULED", paper: { id: paper.id, version: 1 }, batch: { id: batch.id }, totals: { questionCount: 2, totalMarks: 4 } });
    expect(a.scheduledAt).not.toBeNull();
    await expectError(publishAssessment(admin, created.id), ConflictError);
  });

  it("totals follow the paper's section attempt rules", async () => {
    const { admin, course, batch } = await world();
    const paper = await createReadyPaper(admin, course.id, {
      sections: [{ title: "Best 2", attemptRule: "BEST_N", attemptCount: 2, questions: [mcqSingle({ text: "a", marks: 2 }), mcqSingle({ text: "b", marks: 5 }), mcqSingle({ text: "c", marks: 3 })] }],
    });
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id, passingMarks: 9 }));
    const a = await getAssessment(admin, created.id);
    expect(a.totals.totalMarks).toBe(8);
    expect(a.publishIssues).toEqual(["Passing marks (9) exceed total marks (8)."]);
  });
});

// ---------------------------------------------------------------------------
describe("publishing for the batch (Review & Publish)", () => {
  it("publishes and assigns the batch's active learners as candidates in one step", async () => {
    const { admin, course, paper, batch } = await world();
    const disabled = await createUser({ role: Role.LEARNER, name: "Disabled learner", status: UserStatus.DISABLED });
    await db.batchMember.create({ data: { batchId: batch.id, userId: disabled.id } });
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));

    // Learners assigned earlier stay assigned and aren't duplicated.
    const [first] = await listAssessmentLearners(admin, created.id);
    await assignLearnersToAssessment(admin, created.id, [first.id]);

    const { assessment, candidatesAdded } = await publishAssessmentForBatch(admin, created.id);
    expect(assessment.status).toBe("SCHEDULED");
    expect(candidatesAdded).toBe(2);
    const candidates = await db.assessmentCandidate.findMany({ where: { assessmentId: created.id }, select: { learnerId: true } });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.learnerId)).not.toContain(disabled.id);
    expect(await db.auditLog.count({ where: { entityId: created.id, action: "assessment.candidates_assigned" } })).toBe(2);
  });

  it("assigns nobody when publishing is refused", async () => {
    const { admin, course, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { batchId: batch.id }));
    await expect(publishAssessmentForBatch(admin, created.id)).rejects.toThrow(/Select a question paper/);
    expect(await db.assessmentCandidate.count()).toBe(0);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("DRAFT");
  });

  it("lists assessments with their course, batch and paper", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    const { rows } = await listAssessments(admin);
    expect(rows).toEqual([
      expect.objectContaining({
        id: created.id,
        courseId: course.id,
        batch: { id: batch.id, name: batch.name, code: batch.code },
        paper: { id: paper.id, name: "AI for Leaders Final Paper", version: 1 },
        questionCount: 2,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("authorization", () => {
  it("admin can manage assessments", async () => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    await updateAssessment(admin, created.id, { name: "Renamed by admin" });
    await publishAssessment(admin, created.id);
    await expect(listAssessmentLearners(admin, created.id)).resolves.toHaveLength(3);
  });

  it.each([Role.REVIEWER, Role.EXAMINER, Role.LEARNER])("%s cannot create, edit, publish or read assessments", async (role) => {
    const { admin, course, paper, batch } = await world();
    const created = await createAssessment(admin, details(course.id, { paperId: paper.id, batchId: batch.id }));
    const actor = await createActor(role);
    for (const attempt of [
      () => createAssessment(actor, details(course.id, { paperId: paper.id, batchId: batch.id })),
      () => updateAssessment(actor, created.id, { name: "Hijacked" }),
      () => publishAssessment(actor, created.id),
      () => publishAssessmentForBatch(actor, created.id),
      () => transitionAssessment(actor, created.id, "SCHEDULED"),
      () => getAssessment(actor, created.id),
      () => listAssessmentLearners(actor, created.id),
    ]) {
      await expectError(attempt(), ForbiddenError);
    }
    expect((await db.assessment.findUniqueOrThrow({ where: { id: created.id } })).status).toBe("DRAFT");
  });
});
