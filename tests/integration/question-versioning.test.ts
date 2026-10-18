import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { scoreObjectiveAnswer } from "@/lib/scoring/objective";
import { AuditAction } from "@/server/audit";
import { db } from "@/server/db";
import {
  addQuestionsToAssessment,
  createAssessment,
  getAssessment,
  moveQuestionInAssessment,
  refreshAssessmentQuestion,
  updateAssessmentQuestionMarks,
} from "@/server/services/assessments";
import {
  createQuestion,
  deleteQuestion,
  getQuestion,
  listQuestions,
  listTopics,
  setQuestionArchived,
  updateQuestion,
} from "@/server/services/questions";
import { assessmentInput, createActor, createCourse, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

async function draftWith(questionOverrides: Record<string, unknown> = {}, assessmentOverrides: Record<string, unknown> = {}) {
  const admin = await createActor("ADMIN");
  const course = await createCourse();
  const question = await createQuestion(admin, mcqSingle(questionOverrides));
  const assessment = await createAssessment(admin, assessmentInput(course.id, assessmentOverrides));
  await addQuestionsToAssessment(admin, assessment.id, [question.id]);
  const aq = (await getAssessment(admin, assessment.id)).questions[0];
  return { admin, course, question, assessment, aq };
}

describe("question versions", () => {
  it("starts at v1 and bumps only when learner-visible content changes", async () => {
    const admin = await createActor("ADMIN");
    const q = await createQuestion(admin, mcqSingle());
    expect((await getQuestion(admin, q.id)).version).toBe(1);

    await updateQuestion(admin, q.id, mcqSingle({ marks: 5, negativeMarks: 1 })); // marks only
    expect((await getQuestion(admin, q.id)).version).toBe(1);

    await updateQuestion(admin, q.id, mcqSingle({ text: "Reworded?" }));
    expect((await getQuestion(admin, q.id)).version).toBe(2);

    await updateQuestion(admin, q.id, mcqSingle({ text: "Reworded?", options: [{ text: "4", isCorrect: true }, { text: "7", isCorrect: false }] }));
    expect((await getQuestion(admin, q.id)).version).toBe(3); // answer key changed

    await setQuestionArchived(admin, q.id, true);
    expect((await getQuestion(admin, q.id)).version).toBe(3); // status is not content

    const audit = await db.auditLog.findMany({ where: { entityId: q.id, action: AuditAction.QUESTION_UPDATED }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => (a.metadata as { contentChanged: boolean }).contentChanged)).toEqual([false, true, true]);
  });
});

describe("assessment snapshots", () => {
  it("copies the question and its version when added", async () => {
    const { aq } = await draftWith();
    expect(aq.snapshotVersion).toBe(1);
    expect(aq.content).toMatchObject({ version: 1, type: "MCQ_SINGLE", text: "Which is a prime number?" });
    expect(aq.hasNewerVersion).toBe(false);
  });

  it("is not changed by bank edits, even while the assessment is a draft", async () => {
    const { admin, question, assessment } = await draftWith();
    await updateQuestion(
      admin,
      question.id,
      mcqSingle({ text: "Totally different", type: "MCQ_MULTI", options: [{ text: "x", isCorrect: true }, { text: "y", isCorrect: true }] }),
    );

    const aq = (await getAssessment(admin, assessment.id)).questions[0];
    expect(aq.content.text).toBe("Which is a prime number?");
    expect(aq.content.type).toBe("MCQ_SINGLE");
    expect(aq.content.options.map((o) => [o.text, o.isCorrect])).toEqual([
      ["4", false],
      ["7", true],
      ["9", false],
    ]);
    expect(aq).toMatchObject({ snapshotVersion: 1, latestVersion: 2, hasNewerVersion: true });
  });

  it("keeps scoring against the frozen answer key after the bank answer changes", async () => {
    const { admin, question, assessment } = await draftWith();
    const before = (await getAssessment(admin, assessment.id)).questions[0];
    const seven = before.content.options.find((o) => o.text === "7")!.id;

    // In the bank, "4" becomes the correct answer.
    await updateQuestion(admin, question.id, mcqSingle({ options: [{ text: "4", isCorrect: true }, { text: "7", isCorrect: false }] }));

    const row = await db.assessmentQuestion.findFirstOrThrow({ where: { assessmentId: assessment.id } });
    const result = scoreObjectiveAnswer(
      { snapshot: row.snapshot as unknown as QuestionSnapshot, marks: row.marks.toNumber(), negativeMarks: row.negativeMarks.toNumber() },
      [seven],
    );
    expect(result).toEqual({ outcome: "correct", score: 2, maxScore: 2 });
  });

  it("gives each assessment its own copy", async () => {
    const { admin, course, question, assessment } = await draftWith();
    await updateQuestion(admin, question.id, mcqSingle({ text: "Second wording" }));
    const later = await createAssessment(admin, assessmentInput(course.id, { name: "Later" }));
    await addQuestionsToAssessment(admin, later.id, [question.id]);

    const first = (await getAssessment(admin, assessment.id)).questions[0];
    const second = (await getAssessment(admin, later.id)).questions[0];
    expect([first.content.text, first.snapshotVersion]).toEqual(["Which is a prime number?", 1]);
    expect([second.content.text, second.snapshotVersion]).toEqual(["Second wording", 2]);
    expect((await getQuestion(admin, question.id)).usedIn.map((u) => u.questionVersion).sort()).toEqual([1, 2]);
  });
});

describe("explicitly pulling the latest version", () => {
  it("updates a draft's copy and version but keeps assessment marks", async () => {
    const { admin, question, assessment, aq } = await draftWith();
    await updateAssessmentQuestionMarks(admin, assessment.id, aq.id, { marks: 5, negativeMarks: 1 });
    await updateQuestion(admin, question.id, mcqSingle({ text: "Fixed typo" }));

    await refreshAssessmentQuestion(admin, assessment.id, aq.id);

    const after = (await getAssessment(admin, assessment.id)).questions[0];
    expect(after).toMatchObject({ snapshotVersion: 2, hasNewerVersion: false, marks: 5, negativeMarks: 1 });
    expect(after.content.text).toBe("Fixed typo");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.ASSESSMENT_QUESTION_REFRESHED } });
    expect(audit.metadata).toMatchObject({ fromVersion: 1, toVersion: 2 });
  });

  it("is refused once the assessment is scheduled", async () => {
    const { admin, question, assessment, aq } = await draftWith();
    // Publishing now requires an approved paper and a batch; this test is about the status lock on
    // individually picked questions, so put the assessment in SCHEDULED directly.
    await db.assessment.update({ where: { id: assessment.id }, data: { status: "SCHEDULED" } });
    await updateQuestion(admin, question.id, mcqSingle({ text: "Too late" }));
    await expect(refreshAssessmentQuestion(admin, assessment.id, aq.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await getAssessment(admin, assessment.id)).questions[0].content.text).toBe("Which is a prime number?");
  });

  it("is refused if the bank question is inactive or no longer fits the assessment type", async () => {
    const { admin, question, assessment, aq } = await draftWith();
    await updateQuestion(admin, question.id, shortAnswer());
    await expect(refreshAssessmentQuestion(admin, assessment.id, aq.id)).rejects.toThrow(/does not fit/);

    await updateQuestion(admin, question.id, mcqSingle({ text: "Back to MCQ" }));
    await setQuestionArchived(admin, question.id, true);
    await expect(refreshAssessmentQuestion(admin, assessment.id, aq.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("drops negative marks if the latest version became subjective (mixed assessment)", async () => {
    const { admin, question, assessment, aq } = await draftWith({}, { type: "MIXED" });
    await updateQuestion(admin, question.id, shortAnswer());
    await refreshAssessmentQuestion(admin, assessment.id, aq.id);
    const after = (await getAssessment(admin, assessment.id)).questions[0];
    expect(after.content.type).toBe("SHORT_ANSWER");
    expect(after.negativeMarks).toBe(0);
  });
});

describe("ordering", () => {
  it("preserves selection order and supports moving questions", async () => {
    const admin = await createActor("ADMIN");
    const course = await createCourse();
    const a = await createAssessment(admin, assessmentInput(course.id));
    const ids = [];
    for (const t of ["A", "B", "C", "D"]) ids.push((await createQuestion(admin, mcqSingle({ text: t }))).id);
    await addQuestionsToAssessment(admin, a.id, [ids[2], ids[0], ids[3], ids[1]]);
    let qs = (await getAssessment(admin, a.id)).questions;
    expect(qs.map((q) => q.content.text)).toEqual(["C", "A", "D", "B"]);

    await moveQuestionInAssessment(admin, a.id, qs[3].id, "up");
    await moveQuestionInAssessment(admin, a.id, qs[0].id, "down");
    qs = (await getAssessment(admin, a.id)).questions;
    expect(qs.map((q) => q.content.text)).toEqual(["A", "C", "B", "D"]);
    expect(qs.map((q) => q.position)).toEqual([1, 2, 3, 4]);
  });
});

describe("delete vs deactivate", () => {
  it("deletes a question that was never used", async () => {
    const admin = await createActor("ADMIN");
    const q = await createQuestion(admin, mcqSingle());
    await deleteQuestion(admin, q.id);
    expect(await db.question.count()).toBe(0);
    expect(await db.questionOption.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: AuditAction.QUESTION_DELETED, entityId: q.id } })).toBe(1);
  });

  it("refuses to delete a question used by an assessment", async () => {
    const { admin, question } = await draftWith();
    await expect(deleteQuestion(admin, question.id)).rejects.toThrow(/Deactivate it instead/);
    expect(await db.question.count()).toBe(1);
  });

  it("deactivated questions stay in existing assessments but cannot be newly added", async () => {
    const { admin, course, question, assessment } = await draftWith();
    await setQuestionArchived(admin, question.id, true);
    expect((await getAssessment(admin, assessment.id)).questions).toHaveLength(1);
    const other = await createAssessment(admin, assessmentInput(course.id, { name: "Other" }));
    await expect(addQuestionsToAssessment(admin, other.id, [question.id])).rejects.toThrow(/Inactive questions cannot be added/);
  });
});

describe("topic filter", () => {
  it("filters by exact topic, case-insensitively, and lists distinct topics", async () => {
    const admin = await createActor("ADMIN");
    await createQuestion(admin, mcqSingle({ topic: "SQL" }));
    await createQuestion(admin, mcqSingle({ topic: "SQL" }));
    await createQuestion(admin, mcqSingle({ topic: "SQL joins" }));
    await createQuestion(admin, shortAnswer({ topic: null }));

    expect(await listTopics(admin)).toEqual(["SQL", "SQL joins"]);
    expect((await listQuestions(admin, { topic: "sql" })).total).toBe(2);
    expect((await listQuestions(admin, { topic: "SQL joins" })).total).toBe(1);
  });
});
