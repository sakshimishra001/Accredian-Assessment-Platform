import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import {
  addQuestionsToAssessment,
  createAssessment,
  getAssessment,
  listAddableQuestions,
  listAssessments,
  moveQuestionInAssessment,
  removeQuestionFromAssessment,
  syncTimeBasedStatuses,
  transitionAssessment,
  updateAssessment,
  updateAssessmentQuestionMarks,
} from "@/server/services/assessments";
import { createQuestion, setQuestionArchived, updateQuestion } from "@/server/services/questions";
import {
  assessmentInput,
  createActor,
  createReadyPaper,
  createBatchWithLearners,
  createCourse,
  hoursFromNow,
  mcqSingle,
  resetDatabase,
  shortAnswer,
  type PaperSectionSpec,
} from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

async function setup(overrides: Record<string, unknown> = {}) {
  const admin = await createActor("ADMIN");
  const course = await createCourse();
  const assessment = await createAssessment(admin, assessmentInput(course.id, overrides));
  return { admin, course, assessment };
}

/**
 * A draft that can be published: an approved paper (default: two MCQs "Q1", "Q2") and a batch with
 * learners, both in the assessment's course. Publishing requires both since the Assessment Builder.
 */
async function publishable(overrides: Record<string, unknown> = {}, sections?: PaperSectionSpec[]) {
  const admin = await createActor("ADMIN");
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections });
  const batch = await createBatchWithLearners(course.id, 2);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, ...overrides }));
  return { admin, course, assessment, paper, batch, qids: paper.questionIds };
}

async function withQuestions(admin: SessionUser, assessmentId: string, count = 2) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await createQuestion(admin, mcqSingle({ text: `Q${i + 1}` }))).id);
  await addQuestionsToAssessment(admin, assessmentId, ids);
  return ids;
}

describe("assessment creation", () => {
  it("creates a draft with all settings and audits it", async () => {
    const { admin, course, assessment } = await setup({ maxAttempts: 2, proctoringEnabled: true, passingMarks: 3.5 });
    const a = await getAssessment(admin, assessment.id);
    expect(a).toMatchObject({
      status: "DRAFT",
      name: "Unit test",
      course: { id: course.id },
      type: "OBJECTIVE",
      durationMinutes: 60,
      maxAttempts: 2,
      passingMarks: 3.5,
      resultVisibility: "ON_PUBLISH",
      proctoringEnabled: true,
      totals: { questionCount: 0, totalMarks: 0 },
      canEditQuestions: true,
    });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.ASSESSMENT_CREATED } });
    expect(audit).toMatchObject({ actorId: admin.id, entityId: assessment.id });
  });

  it("always starts in DRAFT even if a status is supplied", async () => {
    const { assessment } = await setup({ status: "PUBLISHED" });
    expect(assessment.status).toBe("DRAFT");
  });

  it("rejects invalid settings with field errors", async () => {
    const admin = await createActor("ADMIN");
    const course = await createCourse();
    const err = await createAssessment(
      admin,
      assessmentInput(course.id, { name: "", durationMinutes: 0, endAt: hoursFromNow(23), maxAttempts: 0 }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(Object.keys(err.fieldErrors)).toEqual(expect.arrayContaining(["name", "durationMinutes", "maxAttempts"]));
    expect(await db.assessment.count()).toBe(0);
  });

  it("rejects a window shorter than the duration", async () => {
    const admin = await createActor("ADMIN");
    const course = await createCourse();
    const err = await createAssessment(admin, assessmentInput(course.id, { durationMinutes: 180 })).catch((e) => e);
    expect(err.fieldErrors.endAt[0]).toMatch(/at least as long as the duration/);
  });

  it("rejects an unknown course", async () => {
    const admin = await createActor("ADMIN");
    const err = await createAssessment(admin, assessmentInput("missing")).catch((e) => e);
    expect(err.fieldErrors.courseId).toEqual(["Course not found"]);
  });
});

describe("question association", () => {
  it("adds questions in order with default marks and shows total marks", async () => {
    const { admin, assessment } = await setup();
    await withQuestions(admin, assessment.id, 3);
    const a = await getAssessment(admin, assessment.id);
    expect(a.questions.map((q) => [q.position, q.content.text, q.marks, q.negativeMarks])).toEqual([
      [1, "Q1", 2, 0.5],
      [2, "Q2", 2, 0.5],
      [3, "Q3", 2, 0.5],
    ]);
    expect(a.totals).toMatchObject({ questionCount: 3, totalMarks: 6 });
  });

  it("skips questions already in the assessment", async () => {
    const { admin, assessment } = await setup();
    const [q1] = await withQuestions(admin, assessment.id, 1);
    const q2 = await createQuestion(admin, mcqSingle());
    expect(await addQuestionsToAssessment(admin, assessment.id, [q1, q2.id])).toEqual({ added: 1, skipped: 1 });
  });

  it("refuses archived questions", async () => {
    const { admin, assessment } = await setup();
    const q = await createQuestion(admin, mcqSingle());
    await setQuestionArchived(admin, q.id, true);
    await expect(addQuestionsToAssessment(admin, assessment.id, [q.id])).rejects.toThrow(/Inactive questions cannot be added/);
    const addable = await listAddableQuestions(admin, assessment.id);
    expect(addable.rows).toHaveLength(0);
  });

  it("refuses questions that do not fit the assessment type", async () => {
    const { admin, assessment } = await setup({ type: "OBJECTIVE" });
    const q = await createQuestion(admin, shortAnswer());
    await expect(addQuestionsToAssessment(admin, assessment.id, [q.id])).rejects.toBeInstanceOf(ValidationError);
    expect((await listAddableQuestions(admin, assessment.id)).allowedTypes).not.toContain("SHORT_ANSWER");
  });

  it("removes a question and renumbers the rest", async () => {
    const { admin, assessment } = await setup();
    await withQuestions(admin, assessment.id, 3);
    const before = await getAssessment(admin, assessment.id);
    await removeQuestionFromAssessment(admin, assessment.id, before.questions[0].id);
    const after = await getAssessment(admin, assessment.id);
    expect(after.questions.map((q) => [q.position, q.content.text])).toEqual([
      [1, "Q2"],
      [2, "Q3"],
    ]);
    expect(after.totals.totalMarks).toBe(4);
  });

  it("reorders questions", async () => {
    const { admin, assessment } = await setup();
    await withQuestions(admin, assessment.id, 3);
    const a = await getAssessment(admin, assessment.id);
    await moveQuestionInAssessment(admin, assessment.id, a.questions[2].id, "up");
    await moveQuestionInAssessment(admin, assessment.id, a.questions[0].id, "up"); // already first: no-op
    const b = await getAssessment(admin, assessment.id);
    expect(b.questions.map((q) => q.content.text)).toEqual(["Q1", "Q3", "Q2"]);
    expect(b.questions.map((q) => q.position)).toEqual([1, 2, 3]);
  });

  it("overrides marks per assessment and validates them", async () => {
    const { admin, assessment } = await setup();
    await withQuestions(admin, assessment.id, 2);
    const a = await getAssessment(admin, assessment.id);
    await updateAssessmentQuestionMarks(admin, assessment.id, a.questions[0].id, { marks: "4.5", negativeMarks: "1" });
    expect((await getAssessment(admin, assessment.id)).totals.totalMarks).toBe(6.5);
    await expect(
      updateAssessmentQuestionMarks(admin, assessment.id, a.questions[0].id, { marks: 1, negativeMarks: 2 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAssessmentQuestionMarks(admin, assessment.id, a.questions[0].id, { marks: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("blocks changing the type when existing questions would not fit", async () => {
    const { admin, assessment } = await setup();
    await withQuestions(admin, assessment.id, 1);
    const err = await updateAssessment(admin, assessment.id, { type: "SUBJECTIVE" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fieldErrors.type[0]).toMatch(/do not fit/);
    await updateAssessment(admin, assessment.id, { type: "MIXED" }); // objective questions fit a mixed assessment
  });
});

describe("assessment state transitions", () => {
  it("cannot be scheduled without questions", async () => {
    const { admin, assessment } = await setup();
    await expect(transitionAssessment(admin, assessment.id, "SCHEDULED")).rejects.toThrow(/Add at least one question/);
  });

  it("cannot be scheduled when passing marks exceed total", async () => {
    const { admin, assessment } = await setup({ passingMarks: 50 });
    await withQuestions(admin, assessment.id, 1);
    await expect(transitionAssessment(admin, assessment.id, "SCHEDULED")).rejects.toThrow(/exceed total marks/);
  });

  it("cannot be scheduled with an archived question still attached", async () => {
    const { admin, assessment } = await setup();
    const [qid] = await withQuestions(admin, assessment.id, 1);
    await setQuestionArchived(admin, qid, true);
    await expect(transitionAssessment(admin, assessment.id, "SCHEDULED")).rejects.toThrow(/inactive question/);
  });

  it("rejects transitions that skip the lifecycle", async () => {
    const { admin, assessment } = await setup();
    await expect(transitionAssessment(admin, assessment.id, "PUBLISHED")).rejects.toBeInstanceOf(ConflictError);
    await expect(transitionAssessment(admin, assessment.id, "ACTIVE")).rejects.toBeInstanceOf(ConflictError);
  });

  it("runs the full objective lifecycle with time-driven activation and audit trail", async () => {
    const { admin, assessment } = await publishable();
    const id = assessment.id;

    await transitionAssessment(admin, id, "SCHEDULED");
    expect((await getAssessment(admin, id)).status).toBe("SCHEDULED");

    // Start time passes → ACTIVE automatically.
    const duringWindow = hoursFromNow(25);
    expect((await getAssessment(admin, id, duringWindow)).status).toBe("ACTIVE");

    // End time passes → ENDED automatically.
    await syncTimeBasedStatuses(hoursFromNow(27));
    expect((await db.assessment.findUniqueOrThrow({ where: { id } })).status).toBe("ENDED");

    await transitionAssessment(admin, id, "RESULT_READY");
    await transitionAssessment(admin, id, "PUBLISHED");
    await transitionAssessment(admin, id, "ARCHIVED");
    const final = await db.assessment.findUniqueOrThrow({ where: { id } });
    expect(final.status).toBe("ARCHIVED");
    expect(final.publishedAt).not.toBeNull();
    expect(final.archivedAt).not.toBeNull();

    const moves = (
      await db.auditLog.findMany({ where: { entityId: id, action: AuditAction.ASSESSMENT_STATUS_CHANGED }, orderBy: { createdAt: "asc" } })
    ).map((l) => {
      const m = l.metadata as { from: string; to: string; trigger: string };
      return `${m.from}->${m.to}:${m.trigger}`;
    });
    expect(moves).toEqual([
      "DRAFT->SCHEDULED:manual",
      "SCHEDULED->ACTIVE:system",
      "ACTIVE->ENDED:system",
      "ENDED->RESULT_READY:manual",
      "RESULT_READY->PUBLISHED:manual",
      "PUBLISHED->ARCHIVED:manual",
    ]);
  });

  it("routes mixed assessments through evaluation", async () => {
    const { admin, assessment } = await publishable({ type: "MIXED" }, [{ questions: [mcqSingle(), shortAnswer()] }]);
    await transitionAssessment(admin, assessment.id, "SCHEDULED");
    const now = hoursFromNow(25);
    await transitionAssessment(admin, assessment.id, "ENDED", now); // end early while active
    await expect(transitionAssessment(admin, assessment.id, "RESULT_READY", now)).rejects.toThrow(/evaluation first/);
    await transitionAssessment(admin, assessment.id, "EVALUATION", now);
    await transitionAssessment(admin, assessment.id, "RESULT_READY", now);
    await transitionAssessment(admin, assessment.id, "EVALUATION", now); // reopen
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("EVALUATION");
  });

  it("can move a scheduled assessment back to draft before it starts", async () => {
    const { admin, assessment } = await publishable();
    await transitionAssessment(admin, assessment.id, "SCHEDULED");
    await transitionAssessment(admin, assessment.id, "DRAFT");
    const a = await getAssessment(admin, assessment.id);
    expect(a.status).toBe("DRAFT");
    expect(a.editableFields).toContain("paperId");
    // After the start time it is too late.
    await transitionAssessment(admin, assessment.id, "SCHEDULED");
    await expect(transitionAssessment(admin, assessment.id, "DRAFT", hoursFromNow(25))).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("locking after scheduling / activation", () => {
  async function scheduled() {
    const ctx = await publishable();
    await transitionAssessment(ctx.admin, ctx.assessment.id, "SCHEDULED");
    return ctx;
  }

  it("freezes question membership, order and marks once scheduled", async () => {
    const { admin, assessment } = await scheduled();
    const a = await getAssessment(admin, assessment.id);
    const extra = await createQuestion(admin, mcqSingle());
    await expect(addQuestionsToAssessment(admin, assessment.id, [extra.id])).rejects.toBeInstanceOf(ConflictError);
    await expect(removeQuestionFromAssessment(admin, assessment.id, a.questions[0].id)).rejects.toBeInstanceOf(ConflictError);
    await expect(moveQuestionInAssessment(admin, assessment.id, a.questions[1].id, "up")).rejects.toBeInstanceOf(ConflictError);
    await expect(updateAssessmentQuestionMarks(admin, assessment.id, a.questions[0].id, { marks: 9 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("allows cosmetic and schedule edits while scheduled but not rule changes", async () => {
    const { admin, assessment } = await scheduled();
    await updateAssessment(admin, assessment.id, { name: "Renamed", startAt: hoursFromNow(30), endAt: hoursFromNow(32) });
    expect((await getAssessment(admin, assessment.id)).name).toBe("Renamed");
    await expect(updateAssessment(admin, assessment.id, { durationMinutes: 30 })).rejects.toThrow(/Duration cannot be changed/);
    await expect(updateAssessment(admin, assessment.id, { passingMarks: 2 })).rejects.toBeInstanceOf(ConflictError);
    const err = await updateAssessment(admin, assessment.id, { startAt: hoursFromNow(-1) }).catch((e) => e);
    expect(err.fieldErrors.startAt).toBeDefined();
  });

  it("locks everything except extending the end time once active", async () => {
    const { admin, assessment } = await scheduled();
    const now = hoursFromNow(25);
    expect((await getAssessment(admin, assessment.id, now)).status).toBe("ACTIVE");

    await expect(updateAssessment(admin, assessment.id, { name: "Changed" }, now)).rejects.toBeInstanceOf(ConflictError);
    const shorten = await updateAssessment(admin, assessment.id, { endAt: hoursFromNow(25.5) }, now).catch((e) => e);
    expect(shorten.fieldErrors.endAt[0]).toMatch(/only be extended/);
    await updateAssessment(admin, assessment.id, { endAt: hoursFromNow(28) }, now);
    expect((await getAssessment(admin, assessment.id, now)).endAt.getTime()).toBe(hoursFromNow(28).getTime());

    const a = await getAssessment(admin, assessment.id, now);
    await expect(removeQuestionFromAssessment(admin, assessment.id, a.questions[0].id)).rejects.toThrow(/locked/);
  });

  it("is read-only after the assessment ends", async () => {
    const { admin, assessment } = await scheduled();
    await syncTimeBasedStatuses(hoursFromNow(27));
    await expect(updateAssessment(admin, assessment.id, { endAt: hoursFromNow(40) }, hoursFromNow(27))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("keeps the frozen snapshot when the bank question is edited later", async () => {
    const { admin, assessment, qids } = await scheduled();
    await updateQuestion(
      admin,
      qids[0],
      mcqSingle({ text: "EDITED TEXT", options: [{ text: "x", isCorrect: true }, { text: "y", isCorrect: false }] }),
    );
    const a = await getAssessment(admin, assessment.id);
    expect(a.questions[0].content.text).toBe("Q1");
    expect(a.questions[0].content.options.map((o) => o.text)).toEqual(["4", "7", "9"]);

    // Archiving the bank question also leaves the scheduled assessment intact.
    await setQuestionArchived(admin, qids[1], true);
    expect((await getAssessment(admin, assessment.id)).questions).toHaveLength(2);
  });

  it("does not pull bank edits into a draft when it is scheduled", async () => {
    const { admin, assessment, qids } = await publishable();
    const [qid] = qids;
    await updateQuestion(admin, qid, mcqSingle({ text: "Edited in bank" }));
    expect((await getAssessment(admin, assessment.id)).questions[0].content.text).toBe("Q1"); // draft keeps its copy
    await transitionAssessment(admin, assessment.id, "SCHEDULED");
    const row = await db.assessmentQuestion.findFirstOrThrow({ where: { assessmentId: assessment.id } });
    expect((row.snapshot as { text: string }).text).toBe("Q1");
  });
});

describe("assessment authorization", () => {
  it.each(["LEARNER", "EXAMINER"] as const)("denies every admin operation to %s", async (role) => {
    const { admin, course, assessment } = await setup();
    const [qid] = await withQuestions(admin, assessment.id, 1);
    const aq = (await getAssessment(admin, assessment.id)).questions[0];
    const actor = await createActor(role);

    const attempts: Array<() => Promise<unknown>> = [
      () => listAssessments(actor),
      () => getAssessment(actor, assessment.id),
      () => createAssessment(actor, assessmentInput(course.id)),
      () => updateAssessment(actor, assessment.id, { name: "Hijacked" }),
      () => addQuestionsToAssessment(actor, assessment.id, [qid]),
      () => removeQuestionFromAssessment(actor, assessment.id, aq.id),
      () => moveQuestionInAssessment(actor, assessment.id, aq.id, "down"),
      () => updateAssessmentQuestionMarks(actor, assessment.id, aq.id, { marks: 1 }),
      () => listAddableQuestions(actor, assessment.id),
      () => transitionAssessment(actor, assessment.id, "SCHEDULED"),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(ForbiddenError);

    const unchanged = await getAssessment(admin, assessment.id);
    expect(unchanged).toMatchObject({ name: "Unit test", status: "DRAFT", totals: { questionCount: 1 } });
  });

  it("returns NotFound for an unknown assessment", async () => {
    const admin = await createActor("ADMIN");
    await expect(getAssessment(admin, "missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(addQuestionsToAssessment(admin, "missing", ["x"])).rejects.toBeInstanceOf(NotFoundError);
  });
});
