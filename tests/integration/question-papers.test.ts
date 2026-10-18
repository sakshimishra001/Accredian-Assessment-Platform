import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createPaperFromImport, parseQuestionImport, saveImportToPaper, SUPPORTED_IMPORT_FORMATS } from "@/server/services/question-import";
import {
  addPaperGroup,
  addPaperQuestion,
  addSection,
  createPaperRevision,
  createQuestionPaper,
  getQuestionPaper,
  listQuestionPapers,
  listSelectablePapers,
  removePaperItem,
  removeSection,
  reorderPaperItems,
  reorderSections,
  updatePaperGroup,
  updatePaperQuestion,
  updateQuestionPaper,
  updateSection,
} from "@/server/services/question-papers";
import { createAssessment } from "@/server/services/assessments";
import { deleteQuestion, updateQuestion } from "@/server/services/questions";
import { PAPER_IN_USE_MESSAGE } from "@/lib/papers/rules";
import { assessmentInput, createActor, createCourse, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const expectError = (p: Promise<unknown>, type: new (...args: never[]) => Error) => expect(p).rejects.toBeInstanceOf(type);

async function setup() {
  const admin = await createActor(Role.ADMIN);
  const reviewer = await createActor(Role.REVIEWER);
  const examiner = await createActor(Role.EXAMINER);
  const learner = await createActor(Role.LEARNER);
  const course = await createCourse();
  const paper = await createQuestionPaper(admin, { name: "AI for Leaders Final Exam", courseId: course.id, subject: "AI Strategy", durationMinutes: 90 });
  return { admin, reviewer, examiner, learner, course, paper };
}

/** A complete paper: Section A (2 MCQs), Section B (a case with 2 sub-questions). */
async function buildPaper(admin: SessionUser, paperId: string) {
  const a = await addSection(admin, paperId, { title: "Section A — Objective" });
  const q1 = await addPaperQuestion(admin, a.id, mcqSingle({ text: "What is AI?" }));
  const q2 = await addPaperQuestion(admin, a.id, mcqSingle({ text: "Which is supervised learning?", marks: 3 }));
  const b = await addSection(admin, paperId, { title: "Section B — Case Study", attemptRule: "ALL" });
  const group = await addPaperGroup(admin, b.id, { groupType: "CASE_STUDY", text: "Read the case", passage: "An airline wants to cut delays…" });
  const c1 = await addPaperQuestion(admin, b.id, shortAnswer({ text: "What is the core problem?" }), { parentId: group.id });
  const c2 = await addPaperQuestion(admin, b.id, shortAnswer({ text: "Propose an AI solution." }), { parentId: group.id });
  return { a, b, q1, q2, group, c1, c2 };
}

/** An assessment that uses the paper — from then on the paper can't change. */
const assignToAssessment = async (admin: SessionUser, courseId: string, paperId: string) => createAssessment(admin, assessmentInput(courseId, { name: "Uses the paper", type: "MIXED", paperId }));

const csvFile = (rows: string[]) => ({
  fileName: "ai-final.csv",
  content: ["section,section_rule,section_count,group,group_text,type,question,option_a,option_b,option_c,correct,marks,negative_marks", ...rows].join("\n"),
});

// ---------------------------------------------------------------------------
describe("question paper", () => {
  it("admin creates a draft linked to a course, and updates it", async () => {
    const { admin, course, paper } = await setup();
    expect(paper).toMatchObject({ status: "DRAFT", version: 1 });

    await updateQuestionPaper(admin, paper.id, { name: "AI for Leaders — Final Exam", instructions: "Answer all questions." });

    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail).toMatchObject({ name: "AI for Leaders — Final Exam", instructions: "Answer all questions.", subject: "AI Strategy", course: { id: course.id }, sections: [] });
    await expectError(createQuestionPaper(admin, { name: "No course" }), ValidationError);
    await expectError(createQuestionPaper(admin, { name: "Ghost", courseId: "missing" }), ValidationError);
  });

  it("1/2/4/5: a saved, complete paper is selectable straight away — no review, approval or proctor", async () => {
    const { admin, paper } = await setup();
    await buildPaper(admin, paper.id);

    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail).toMatchObject({ issues: [], inUse: false, assessmentCount: 0 });
    expect((await listSelectablePapers(admin)).map((p) => p.id)).toEqual([paper.id]);
    expect((await listQuestionPapers(admin))[0]).toMatchObject({ id: paper.id, ready: true, inUse: false, questionCount: 4 });
    // Nothing went through a review step.
    expect(await db.auditLog.count({ where: { action: AuditAction.PAPER_STATUS_CHANGED } })).toBe(0);
  });

  it("8/9: an incomplete paper is saved, but isn't offered to assessments until it is complete", async () => {
    const { admin, paper } = await setup();
    expect((await getQuestionPaper(admin, paper.id)).issues).toEqual(["Add at least one section."]);
    expect(await listSelectablePapers(admin)).toEqual([]);
    const s = await addSection(admin, paper.id, { title: "Section A", attemptRule: "EXACTLY_N", attemptCount: 2 });
    await addPaperQuestion(admin, s.id, mcqSingle());
    expect((await getQuestionPaper(admin, paper.id)).issues).toEqual(["“Section A” asks for 2 questions but has only 1."]);
    expect(await listSelectablePapers(admin)).toEqual([]);
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "Second" }));
    expect((await listSelectablePapers(admin)).map((p) => p.id)).toEqual([paper.id]);
  });

  it("10: papers left IN_REVIEW (or APPROVED) before review was removed are usable and editable like any other", async () => {
    const { admin, course } = await setup();
    for (const status of ["IN_REVIEW", "APPROVED"] as const) {
      const legacy = await createQuestionPaper(admin, { name: `Legacy ${status}`, courseId: course.id });
      const { a } = await buildPaper(admin, legacy.id);
      await db.questionPaper.update({ where: { id: legacy.id }, data: { status, submittedAt: new Date() } });
      await updateQuestionPaper(admin, legacy.id, { name: `Legacy ${status} — edited` });
      await addPaperQuestion(admin, a.id, mcqSingle({ text: "Added later" }));
      expect((await listSelectablePapers(admin)).map((p) => p.name)).toContain(`Legacy ${status} — edited`);
      expect((await assignToAssessment(admin, course.id, legacy.id)).id).toEqual(expect.any(String));
    }
  });

  it("6: editable until an assessment uses it; then locked with a clear message", async () => {
    const { admin, course, paper } = await setup();
    const { a, q1, group } = await buildPaper(admin, paper.id);
    await updateQuestionPaper(admin, paper.id, { name: "Edited freely" });
    await updatePaperQuestion(admin, q1.id, mcqSingle({ text: "Rewritten freely" }));

    await assignToAssessment(admin, course.id, paper.id);
    expect(await getQuestionPaper(admin, paper.id)).toMatchObject({ inUse: true, assessmentCount: 1 });
    for (const attempt of [
      () => updateQuestionPaper(admin, paper.id, { name: "Changed while in use" }),
      () => addSection(admin, paper.id, { title: "Extra" }),
      () => updateSection(admin, a.id, { title: "Renamed" }),
      () => removeSection(admin, a.id),
      () => addPaperQuestion(admin, a.id, mcqSingle({ text: "Sneaky" })),
      () => updatePaperQuestion(admin, q1.id, mcqSingle({ text: "Rewritten" })),
      () => updatePaperGroup(admin, group.id, { groupType: "COMPREHENSION", text: "x" }),
      () => removePaperItem(admin, q1.id),
      () => reorderSections(admin, paper.id, []),
    ]) {
      await expect(attempt()).rejects.toThrow(PAPER_IN_USE_MESSAGE);
    }
    // Still listed and selectable for further assessments.
    expect((await listSelectablePapers(admin)).map((p) => p.id)).toEqual([paper.id]);
  });
});

// ---------------------------------------------------------------------------
describe("sections", () => {
  it("creates sections in order, reorders them and renumbers after removal", async () => {
    const { admin, paper } = await setup();
    const a = await addSection(admin, paper.id, { title: "A" });
    const b = await addSection(admin, paper.id, { title: "B", isRequired: false });
    const c = await addSection(admin, paper.id, { title: "C", attemptRule: "BEST_N", attemptCount: 1, instructions: "Best answer counts." });
    expect([a.position, b.position, c.position]).toEqual([1, 2, 3]);
    expect(b.isRequired).toBe(false);
    expect(c).toMatchObject({ attemptRule: "BEST_N", attemptCount: 1, instructions: "Best answer counts." });

    await reorderSections(admin, paper.id, [c.id, a.id, b.id]);
    expect((await getQuestionPaper(admin, paper.id)).sections.map((s) => s.title)).toEqual(["C", "A", "B"]);
    await expectError(reorderSections(admin, paper.id, [c.id, a.id]), ValidationError);

    await removeSection(admin, c.id);
    expect((await getQuestionPaper(admin, paper.id)).sections.map((s) => [s.title, s.position])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
  });

  it("validates attempt rules and updates section configuration", async () => {
    const { admin, paper } = await setup();
    await expectError(addSection(admin, paper.id, { title: "No N", attemptRule: "UP_TO_N" }), ValidationError);
    await expectError(addSection(admin, paper.id, { title: "N with ALL", attemptRule: "ALL", attemptCount: 3 }), ValidationError);
    await expectError(addSection(admin, paper.id, { title: "Zero", attemptRule: "EXACTLY_N", attemptCount: 0 }), ValidationError);
    await expectError(addSection(admin, paper.id, { title: "" }), ValidationError);

    const s = await addSection(admin, paper.id, { title: "Section A" });
    await expect(updateSection(admin, s.id, { title: "Section A", attemptRule: "UP_TO_N", attemptCount: 2, isRequired: false })).resolves.toMatchObject({
      attemptRule: "UP_TO_N",
      attemptCount: 2,
      isRequired: false,
    });
  });

  it("reports section max marks from the attempt rule", async () => {
    const { admin, paper } = await setup();
    const s = await addSection(admin, paper.id, { title: "Best 2", attemptRule: "BEST_N", attemptCount: 2 });
    for (const [text, marks] of [
      ["Q one", 2],
      ["Q two", 5],
      ["Q three", 3],
    ] as const) {
      await addPaperQuestion(admin, s.id, mcqSingle({ text, marks, negativeMarks: 0 }));
    }
    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail.sections[0]).toMatchObject({ maxMarks: 8, itemCount: 3 });
    expect(detail.totalMarks).toBe(8);
  });
});

// ---------------------------------------------------------------------------
describe("questions in a paper", () => {
  it("adds valid questions with frozen snapshots, ordered and numbered within sections", async () => {
    const { admin, course, paper } = await setup();
    await buildPaper(admin, paper.id);

    const detail = await getQuestionPaper(admin, paper.id);
    const [a, b] = detail.sections;
    expect(a.items.map((i) => [i.number, i.kind === "question" ? i.question.text : ""])).toEqual([
      ["1", "What is AI?"],
      ["2", "Which is supervised learning?"],
    ]);
    const q = a.items[0];
    if (q.kind !== "question") throw new Error("expected a question");
    expect(q).toMatchObject({ marks: 2, negativeMarks: 0.5, questionVersion: 1, question: { type: "MCQ_SINGLE", options: [{ text: "4" }, { text: "7", isCorrect: true }, { text: "9" }] } });
    const bank = await db.question.findUniqueOrThrow({ where: { id: q.questionId } });
    expect(bank.courseId).toBe(course.id);

    const group = b.items[0];
    expect(group).toMatchObject({ kind: "group", number: "3", groupType: "CASE_STUDY", passage: "An airline wants to cut delays…", marks: 10 });
    if (group.kind !== "group") throw new Error("expected a group");
    expect(group.children.map((c) => c.number)).toEqual(["3(a)", "3(b)"]);
    expect(detail).toMatchObject({ questionCount: 4, totalMarks: 15, issues: [] });
  });

  it("rejects invalid questions, options and correct answers", async () => {
    const { admin, paper } = await setup();
    const s = await addSection(admin, paper.id, { title: "A" });
    await expectError(addPaperQuestion(admin, s.id, mcqSingle({ text: "" })), ValidationError);
    await expectError(addPaperQuestion(admin, s.id, mcqSingle({ options: [{ text: "Only one", isCorrect: true }] })), ValidationError);
    await expectError(addPaperQuestion(admin, s.id, mcqSingle({ options: [{ text: "A", isCorrect: false }, { text: "B", isCorrect: false }] })), ValidationError);
    await expectError(addPaperQuestion(admin, s.id, mcqSingle({ options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }] })), ValidationError);
    await expectError(addPaperQuestion(admin, s.id, { ...mcqSingle(), type: "ESSAY" }), ValidationError);
    await expectError(addPaperQuestion(admin, s.id, shortAnswer({ negativeMarks: 1 })), ValidationError);
    expect(await db.paperQuestion.count()).toBe(0);
  });

  it("reorders questions at a level and keeps one nesting level only", async () => {
    const { admin, paper } = await setup();
    const { a, q1, q2, b, group, c1 } = await buildPaper(admin, paper.id);
    await reorderPaperItems(admin, a.id, null, [q2.id, q1.id]);
    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail.sections[0].items.map((i) => i.id)).toEqual([q2.id, q1.id]);

    await expectError(addPaperQuestion(admin, b.id, shortAnswer({ text: "Nested too deep" }), { parentId: c1.id }), ValidationError);
    await expectError(addPaperQuestion(admin, a.id, shortAnswer({ text: "Wrong section" }), { parentId: group.id }), NotFoundError);
  });

  it("removing an item renumbers the rest and keeps the bank question", async () => {
    const { admin, paper } = await setup();
    const { q1, q2 } = await buildPaper(admin, paper.id);
    const bankId = (await db.paperQuestion.findUniqueOrThrow({ where: { id: q1.id } })).questionId!;
    await removePaperItem(admin, q1.id);
    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail.sections[0].items.map((i) => [i.id, i.position])).toEqual([[q2.id, 1]]);
    expect(await db.question.count({ where: { id: bankId } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("versioning and snapshots", () => {
  it("editing in a draft bumps the bank version and refreshes that paper's snapshot", async () => {
    const { admin, paper } = await setup();
    const { q1 } = await buildPaper(admin, paper.id);

    await updatePaperQuestion(admin, q1.id, mcqSingle({ text: "What is artificial intelligence?", marks: 4 }));

    const item = (await getQuestionPaper(admin, paper.id)).sections[0].items[0];
    expect(item).toMatchObject({ marks: 4, questionVersion: 2, question: { text: "What is artificial intelligence?", version: 2 } });
  });

  it("a paper in use stays exactly as it is when the bank question is edited later", async () => {
    const { admin, course, paper } = await setup();
    const { q1 } = await buildPaper(admin, paper.id);
    await assignToAssessment(admin, course.id, paper.id);
    const before = await getQuestionPaper(admin, paper.id);
    const bankId = (await db.paperQuestion.findUniqueOrThrow({ where: { id: q1.id } })).questionId!;

    await updateQuestion(admin, bankId, mcqSingle({ text: "Edited in the bank" }));

    const after = await getQuestionPaper(admin, paper.id);
    expect(after.sections).toEqual(before.sections);
    expect(await db.question.findUniqueOrThrow({ where: { id: bankId } })).toMatchObject({ version: 2, text: "Edited in the bank" });
    await expectError(deleteQuestion(admin, bankId), ConflictError);
  });

  it("changes to a paper in use go into a new version; the one in use is untouched", async () => {
    const { admin, course, paper } = await setup();
    await buildPaper(admin, paper.id);
    // Not used yet: edit it directly, no version needed.
    await expect(createPaperRevision(admin, paper.id)).rejects.toThrow(/Edit it directly/);
    await assignToAssessment(admin, course.id, paper.id);
    const v1Before = await getQuestionPaper(admin, paper.id);

    const v2 = await createPaperRevision(admin, paper.id);
    expect(v2).toMatchObject({ version: 2, basedOnId: paper.id });
    await expectError(createPaperRevision(admin, paper.id), ConflictError);

    const v2Detail = await getQuestionPaper(admin, v2.id);
    expect(v2Detail).toMatchObject({ inUse: false, issues: [] });
    expect(v2Detail.sections.map((s) => s.items.length)).toEqual([2, 1]);
    const firstV2 = v2Detail.sections[0].items[0];
    await updatePaperQuestion(admin, firstV2.id, mcqSingle({ text: "What is AI? (v2 wording)" }));
    await addSection(admin, v2.id, { title: "Section C — New" });

    const v1After = await getQuestionPaper(admin, paper.id);
    expect(v1After.sections).toEqual(v1Before.sections);
    const v2After = await getQuestionPaper(admin, v2.id);
    expect(v2After.sections[0].items[0]).toMatchObject({ question: { text: "What is AI? (v2 wording)" } });
    expect(v2After.sections[1].items[0]).toMatchObject({ kind: "group" });
    expect(v2After.sections[1].items[0].kind === "group" && v2After.sections[1].items[0].children).toHaveLength(2);
    await expectError(createPaperRevision(admin, v2.id), ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("import", () => {
  it("parses a valid CSV template into structured sections for review, writing nothing", async () => {
    const { admin } = await setup();
    const parsed = parseQuestionImport(
      admin,
      csvFile([
        "Section A,ANY_N,1,,,MCQ,What is AI?,A field,A fruit,,A,2,0.5",
        "Section A,,,,,MCQ,What is ML?,A subset of AI,A sport,,A,2,0",
        "Section B,,,C1,Read the case,SHORT_ANSWER,Main problem?,,,,,5,",
      ]),
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed).toMatchObject({ format: "csv", summary: { sections: 2, questions: 3, groups: 1 } });
    expect(await db.question.count()).toBe(0);
    expect(SUPPORTED_IMPORT_FORMATS.map((f) => f.ext)).toEqual(["csv"]);
  });

  it("saves a reviewed import into a draft paper in one go", async () => {
    const { admin, paper } = await setup();
    const parsed = parseQuestionImport(
      admin,
      csvFile([
        "Section A,ANY_N,1,,,MCQ,What is AI?,A field,A fruit,,A,2,0.5",
        "Section A,,,,,TRUE_FALSE,AI needs data.,,,,TRUE,1,",
        "Section B,,,C1,Read the case,SHORT_ANSWER,Main problem?,,,,,5,",
        "Section B,,,C1,,LONG_ANSWER,Your plan?,,,,,10,",
      ]),
    );

    const summary = await saveImportToPaper(admin, paper.id, { ...parsed.payload, sourceFileName: parsed.fileName });

    expect(summary).toEqual({ sectionsCreated: 2, questionsAdded: 4, groupsAdded: 1 });
    const detail = await getQuestionPaper(admin, paper.id);
    expect(detail).toMatchObject({ sourceFileName: "ai-final.csv", questionCount: 4, issues: [] });
    expect(detail.sections.map((s) => [s.title, s.attemptRule, s.attemptCount])).toEqual([
      ["Section A", "ANY_N", 1],
      ["Section B", "ALL", null],
    ]);
  });

  it("returns clear errors for invalid rows; an uncorrected payload is rejected without saving anything", async () => {
    const { admin, paper } = await setup();
    const parsed = parseQuestionImport(admin, csvFile(["Section A,,,,,MCQ,Good question,Yes,No,,A,2,", "Section A,,,,,MCQ,Broken question,Yes,No,,,2,"]));
    expect(parsed.issues).toEqual([{ row: 3, field: "correct", message: "Set the correct answer (e.g. B, or A,C for multiple answers)." }]);

    await expect(saveImportToPaper(admin, paper.id, parsed.payload)).rejects.toMatchObject({
      fieldErrors: { "sections.0.items.1.question.options": ["Mark exactly one option as correct"] },
    });
    expect(await db.paperQuestion.count()).toBe(0);
    expect(await db.question.count()).toBe(0);

    // After the admin fixes the row in the review step, the same payload saves.
    const fixed = structuredClone(parsed.payload);
    const broken = fixed.sections[0].items[1];
    if (broken.kind !== "question") throw new Error("expected a question");
    (broken.question.options as { text: string; isCorrect: boolean }[])[0].isCorrect = true;
    await expect(saveImportToPaper(admin, paper.id, fixed)).resolves.toMatchObject({ questionsAdded: 2 });
  });

  it("rejects duplicates within the import and against the paper", async () => {
    const { admin, paper } = await setup();
    const s = await addSection(admin, paper.id, { title: "Section A" });
    await addPaperQuestion(admin, s.id, mcqSingle({ text: "Already here" }));
    const payload = {
      sections: [
        {
          title: "Section A",
          items: [
            { kind: "question", question: mcqSingle({ text: "Already  here" }) },
            { kind: "question", question: mcqSingle({ text: "Twice" }) },
            { kind: "question", question: mcqSingle({ text: "twice" }) },
          ],
        },
      ],
    };
    await expect(saveImportToPaper(admin, paper.id, payload)).rejects.toMatchObject({
      fieldErrors: {
        "sections.0.items.0.question.text": ["This question is already in the paper."],
        "sections.0.items.2.question.text": ["Duplicate of sections.0.items.1.question.text."],
      },
    });
    expect(await db.paperQuestion.count()).toBe(1);
  });

  it("does not leave partial data when the import fails part-way", async () => {
    const { admin, paper } = await setup();
    const payload = {
      sections: [
        { title: "Section A", items: [{ kind: "question", question: mcqSingle({ text: "First" }) }] },
        // Fails inside the transaction (count > items), after Section A would have been written.
        { title: "Section B", attemptRule: "EXACTLY_N", attemptCount: 5, items: [{ kind: "question", question: shortAnswer() }] },
      ],
    };
    await expectError(saveImportToPaper(admin, paper.id, payload), ValidationError);
    expect(await db.paperSection.count()).toBe(0);
    expect(await db.question.count()).toBe(0);
  });

  it("reports unsupported formats and bad files clearly", async () => {
    const { admin, reviewer } = await setup();
    await expect(() => parseQuestionImport(admin, { fileName: "paper.xlsx", content: "" })).toThrow(/Save As → “CSV UTF-8”/);
    await expect(() => parseQuestionImport(admin, { fileName: "paper.pdf", content: "" })).toThrow(/PDF import isn’t supported yet/);
    await expect(() => parseQuestionImport(admin, { fileName: "paper.docx", content: "" })).toThrow(/Word documents aren’t supported yet/);
    await expect(() => parseQuestionImport(admin, { fileName: "paper.txt", content: "" })).toThrow(/Supported: \.csv/);
    await expect(() => parseQuestionImport(admin, { fileName: "bad.csv", content: 'section,type,question,marks\n"unclosed' })).toThrow(ValidationError);
    expect(() => parseQuestionImport(reviewer, csvFile([]))).toThrow(ForbiddenError);
  });

  it("creates a paper and its imported questions in one transaction", async () => {
    const { admin, course } = await setup();
    const parsed = parseQuestionImport(admin, csvFile(["Section A,,,,,MCQ,What is AI?,A field,A fruit,,A,2,0.5", "Section B,,,C1,Read the case,SHORT_ANSWER,Main problem?,,,,,5,"]));
    const { paper, summary } = await createPaperFromImport(admin, { name: "Imported final", courseId: course.id }, { ...parsed.payload, sourceFileName: parsed.fileName });

    expect(summary).toEqual({ sectionsCreated: 2, questionsAdded: 2, groupsAdded: 1 });
    expect(await getQuestionPaper(admin, paper.id)).toMatchObject({ name: "Imported final", status: "DRAFT", version: 1, sourceFileName: "ai-final.csv", questionCount: 2, issues: [] });
    expect(await db.auditLog.count({ where: { entityId: paper.id, action: { in: [AuditAction.PAPER_CREATED, AuditAction.PAPER_IMPORTED] } } })).toBe(2);
  });

  it("creating from an import rolls back the paper when the questions or details are invalid", async () => {
    const { admin, course } = await setup();
    const before = await db.questionPaper.count();
    const bad = { sections: [{ title: "Section A", attemptRule: "EXACTLY_N", attemptCount: 3, items: [{ kind: "question", question: mcqSingle() }] }] };
    await expectError(createPaperFromImport(admin, { name: "Rolled back", courseId: course.id }, bad), ValidationError);
    await expectError(createPaperFromImport(admin, { name: "", courseId: course.id }, { sections: [] }), ValidationError);
    await db.course.update({ where: { id: course.id }, data: { isActive: false } });
    await expectError(createPaperFromImport(admin, { name: "Inactive course", courseId: course.id }, { sections: [{ title: "A", items: [{ kind: "question", question: mcqSingle() }] }] }), ValidationError);
    expect(await db.questionPaper.count()).toBe(before);
    expect(await db.question.count()).toBe(0);
    expect(await db.paperSection.count()).toBe(0);
  });

  it("imports into any paper no assessment uses yet", async () => {
    const { admin, course, paper } = await setup();
    await buildPaper(admin, paper.id);
    const more = { sections: [{ title: "X", items: [{ kind: "question", question: mcqSingle({ text: "New" }) }] }] };
    await saveImportToPaper(admin, paper.id, more);
    await assignToAssessment(admin, course.id, paper.id);
    await expect(saveImportToPaper(admin, paper.id, { sections: [{ title: "Y", items: [{ kind: "question", question: mcqSingle({ text: "Newer" }) }] }] })).rejects.toThrow(PAPER_IN_USE_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
describe("RBAC", () => {
  it("admin has full access", async () => {
    const { admin, paper } = await setup();
    await expect(listQuestionPapers(admin)).resolves.toHaveLength(1);
    await expect(getQuestionPaper(admin, paper.id)).resolves.toMatchObject({ inUse: false });
  });

  it("proctors have no part in question papers (nothing to review): no reading, listing or editing", async () => {
    const { admin, reviewer, paper } = await setup();
    const { a } = await buildPaper(admin, paper.id);
    await expectError(getQuestionPaper(reviewer, paper.id), ForbiddenError);
    await expectError(listQuestionPapers(reviewer), ForbiddenError);
    await expectError(listSelectablePapers(reviewer), ForbiddenError);
    await expectError(updateQuestionPaper(reviewer, paper.id, { name: "Proctor edit" }), ForbiddenError);
    await expectError(addPaperQuestion(reviewer, a.id, mcqSingle({ text: "Proctor question" })), ForbiddenError);
  });

  it.each([Role.EXAMINER, Role.LEARNER])("%s is blocked from every paper operation", async (role) => {
    const { admin, paper } = await setup();
    const { a, q1 } = await buildPaper(admin, paper.id);
    const actor = await createActor(role);
    for (const attempt of [
      async () => createQuestionPaper(actor, { name: "Mine", courseId: (await db.course.findFirstOrThrow()).id }),
      () => listQuestionPapers(actor),
      () => getQuestionPaper(actor, paper.id),
      () => updateQuestionPaper(actor, paper.id, { name: "Hijacked" }),
      () => addSection(actor, paper.id, { title: "Extra" }),
      () => addPaperQuestion(actor, a.id, mcqSingle({ text: "Injected" })),
      () => updatePaperQuestion(actor, q1.id, mcqSingle({ text: "Changed" })),
      () => createPaperRevision(actor, paper.id),
      () => saveImportToPaper(actor, paper.id, { sections: [] }),
    ]) {
      await expectError(attempt(), ForbiddenError);
    }
    expect(() => parseQuestionImport(actor, csvFile([]))).toThrow(ForbiddenError);
    expect((await getQuestionPaper(admin, paper.id)).name).toBe("AI for Leaders Final Exam");
  });
});
