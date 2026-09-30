import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { db } from "@/server/db";
import {
  createQuestion,
  getQuestion,
  listQuestions,
  setQuestionArchived,
  updateQuestion,
} from "@/server/services/questions";
import { createActor, createCourse, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

describe("question bank", () => {
  it("creates a question with options, metadata and an audit record", async () => {
    const admin = await createActor("ADMIN");
    const course = await createCourse();
    const q = await createQuestion(admin, mcqSingle({ courseId: course.id, difficulty: "HARD" }));

    const detail = await getQuestion(admin, q.id);
    expect(detail).toMatchObject({
      type: "MCQ_SINGLE",
      marks: 2,
      negativeMarks: 0.5,
      topic: "Numbers",
      difficulty: "HARD",
      isArchived: false,
      course: { id: course.id },
      createdBy: { name: admin.name },
    });
    expect(detail.options.map((o) => [o.text, o.isCorrect, o.position])).toEqual([
      ["4", false, 0],
      ["7", true, 1],
      ["9", false, 2],
    ]);
    expect(await db.auditLog.count({ where: { action: AuditAction.QUESTION_CREATED, entityId: q.id } })).toBe(1);
  });

  it("rejects invalid input with field errors", async () => {
    const admin = await createActor("ADMIN");
    const err = await createQuestion(admin, mcqSingle({ text: "", options: [{ text: "A", isCorrect: true }, { text: "B", isCorrect: true }] })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors.text).toBeDefined();
    expect(err.fieldErrors.options).toContain("Mark exactly one option as correct");
    expect(await db.question.count()).toBe(0);
  });

  it("rejects an unknown course", async () => {
    const admin = await createActor("ADMIN");
    const err = await createQuestion(admin, mcqSingle({ courseId: "missing" })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors.courseId).toBeDefined();
  });

  it("updates text and replaces options", async () => {
    const admin = await createActor("ADMIN");
    const q = await createQuestion(admin, mcqSingle());
    await updateQuestion(admin, q.id, mcqSingle({ type: "MCQ_MULTI", text: "Pick primes", options: [{ text: "2", isCorrect: true }, { text: "3", isCorrect: true }] }));

    const detail = await getQuestion(admin, q.id);
    expect(detail.type).toBe("MCQ_MULTI");
    expect(detail.text).toBe("Pick primes");
    expect(detail.options).toHaveLength(2);
    expect(detail.updatedBy?.name).toBe(admin.name);
  });

  it("archives and restores", async () => {
    const admin = await createActor("ADMIN");
    const q = await createQuestion(admin, shortAnswer());
    await setQuestionArchived(admin, q.id, true);
    expect((await getQuestion(admin, q.id)).isArchived).toBe(true);
    await setQuestionArchived(admin, q.id, false);
    expect((await getQuestion(admin, q.id)).isArchived).toBe(false);
    const actions = (await db.auditLog.findMany({ where: { entityId: q.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual([AuditAction.QUESTION_CREATED, AuditAction.QUESTION_ARCHIVED, AuditAction.QUESTION_RESTORED]);
  });

  it("searches and filters by type, difficulty and status", async () => {
    const admin = await createActor("ADMIN");
    await createQuestion(admin, mcqSingle({ text: "Median of a set", topic: "Statistics" }));
    await createQuestion(admin, mcqSingle({ text: "SQL JOIN types", topic: "SQL", difficulty: "HARD" }));
    const archived = await createQuestion(admin, shortAnswer({ text: "Explain joins" }));
    await setQuestionArchived(admin, archived.id, true);

    expect((await listQuestions(admin, { q: "statistics" })).total).toBe(1); // matches topic
    expect((await listQuestions(admin, { q: "join" })).total).toBe(1); // archived excluded by default
    expect((await listQuestions(admin, { q: "join", status: "all" })).total).toBe(2);
    expect((await listQuestions(admin, { status: "archived" })).rows.map((r) => r.id)).toEqual([archived.id]);
    expect((await listQuestions(admin, { type: "SHORT_ANSWER" })).total).toBe(0);
    expect((await listQuestions(admin, { difficulty: "HARD" })).total).toBe(1);
  });

  it("returns NotFound for unknown ids", async () => {
    const admin = await createActor("ADMIN");
    await expect(getQuestion(admin, "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateQuestion(admin, "nope", shortAnswer())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("question bank authorization", () => {
  it.each(["LEARNER", "EXAMINER"] as const)("denies every operation to %s", async (role) => {
    const admin = await createActor("ADMIN");
    const actor = await createActor(role);
    const q = await createQuestion(admin, shortAnswer());

    await expect(listQuestions(actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getQuestion(actor, q.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createQuestion(actor, shortAnswer())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateQuestion(actor, q.id, shortAnswer({ text: "hacked" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setQuestionArchived(actor, q.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getQuestion(admin, q.id)).text).toBe("Define variance.");
  });
});
