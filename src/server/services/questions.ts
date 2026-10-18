import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Difficulty, QuestionType } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { buildSnapshot, snapshotDiffers } from "@/lib/questions/snapshot";
import { questionInputSchema, type QuestionData } from "@/lib/validation/question";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";

export const QUESTION_PAGE_SIZE = 25;

export type QuestionStatusFilter = "active" | "archived" | "all";

export interface QuestionFilters {
  q?: string;
  type?: QuestionType;
  difficulty?: Difficulty;
  /** Exact topic match (case-insensitive). */
  topic?: string;
  status?: QuestionStatusFilter;
  page?: number;
}

export function buildQuestionWhere(filters: QuestionFilters): Prisma.QuestionWhereInput {
  const where: Prisma.QuestionWhereInput = {};
  const status = filters.status ?? "active";
  if (status !== "all") where.isArchived = status === "archived";
  if (filters.type) where.type = filters.type;
  if (filters.difficulty) where.difficulty = filters.difficulty;
  const topic = filters.topic?.trim();
  if (topic) where.topic = { equals: topic, mode: "insensitive" };
  const q = filters.q?.trim();
  if (q) {
    where.OR = [
      { text: { contains: q, mode: "insensitive" } },
      { topic: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export async function listQuestions(actor: SessionUser, filters: QuestionFilters = {}) {
  assertAdmin(actor);
  const where = buildQuestionWhere(filters);
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const [total, rows] = await Promise.all([
    db.question.count({ where }),
    db.question.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * QUESTION_PAGE_SIZE,
      take: QUESTION_PAGE_SIZE,
      select: {
        id: true,
        type: true,
        text: true,
        marks: true,
        negativeMarks: true,
        topic: true,
        difficulty: true,
        isArchived: true,
        version: true,
        updatedAt: true,
        course: { select: { code: true } },
        _count: { select: { assessments: true } },
      },
    }),
  ]);
  return {
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / QUESTION_PAGE_SIZE)),
    rows: rows.map((r) => ({
      ...r,
      marks: r.marks.toNumber(),
      negativeMarks: r.negativeMarks.toNumber(),
      usageCount: r._count.assessments,
    })),
  };
}

export async function getQuestion(actor: SessionUser, id: string) {
  assertAdmin(actor);
  const q = await db.question.findUnique({
    where: { id },
    include: {
      options: { orderBy: { position: "asc" } },
      course: { select: { id: true, code: true, name: true } },
      createdBy: { select: { name: true } },
      assessments: {
        orderBy: { createdAt: "desc" },
        select: { questionVersion: true, assessment: { select: { id: true, name: true, status: true } } },
      },
    },
  });
  if (!q) throw new NotFoundError("Question not found.");
  const updatedBy = q.updatedById
    ? await db.user.findUnique({ where: { id: q.updatedById }, select: { name: true } })
    : null;
  return {
    ...q,
    marks: q.marks.toNumber(),
    negativeMarks: q.negativeMarks.toNumber(),
    updatedBy,
    usedIn: q.assessments.map((a) => ({ ...a.assessment, questionVersion: a.questionVersion })),
  };
}

export type QuestionDetail = Awaited<ReturnType<typeof getQuestion>>;

export function parseQuestion(raw: unknown): QuestionData {
  const parsed = questionInputSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

async function assertCourseExists(tx: DbTx, courseId: string | null) {
  if (!courseId) return;
  const exists = await tx.course.count({ where: { id: courseId } });
  if (!exists) throw new ValidationError("Please correct the highlighted fields.", { courseId: ["Course not found"] });
}

function questionColumns(data: QuestionData) {
  return {
    type: data.type,
    text: data.text,
    guidance: data.guidance,
    marks: data.marks,
    negativeMarks: data.negativeMarks,
    topic: data.topic,
    difficulty: data.difficulty,
    courseId: data.courseId,
  };
}

/** Create a bank question inside an existing transaction (used by question papers and imports). */
export async function insertQuestion(tx: DbTx, actorId: string, data: QuestionData) {
  await assertCourseExists(tx, data.courseId);
  const question = await tx.question.create({
    data: {
      ...questionColumns(data),
      createdById: actorId,
      options: { create: data.options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i })) },
    },
    include: { options: true },
  });
  await recordAudit(
    { actorId, action: AuditAction.QUESTION_CREATED, entityType: "Question", entityId: question.id, metadata: { type: data.type } },
    tx,
  );
  return question;
}

export async function createQuestion(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const data = parseQuestion(raw);
  return db.$transaction((tx) => insertQuestion(tx, actor.id, data));
}

/**
 * Edits the bank question only. Assessment snapshots are separate copies and are never touched,
 * so scheduled/active/past assessments keep exactly what learners saw.
 */
export async function updateQuestion(actor: SessionUser, id: string, raw: unknown) {
  assertAdmin(actor);
  const data = parseQuestion(raw);
  return db.$transaction((tx) => applyQuestionUpdate(tx, actor.id, id, data));
}

/**
 * Update a bank question inside an existing transaction. The version is bumped only when
 * learner-visible content changes. Snapshots held by assessments and papers are not touched here.
 */
export async function applyQuestionUpdate(tx: DbTx, actorId: string, id: string, data: QuestionData) {
  const existing = await tx.question.findUnique({ where: { id }, include: { options: true } });
  if (!existing) throw new NotFoundError("Question not found.");
  await assertCourseExists(tx, data.courseId);

  // Bump the version only when learner-visible content changes (not for marks/course tweaks),
  // so "newer version available" on assessments means something real.
  const proposed = buildSnapshot({
    ...existing,
    ...data,
    options: data.options.map((o, i) => ({ id: `new-${i}`, text: o.text, isCorrect: o.isCorrect, position: i })),
  });
  const contentChanged = snapshotDiffers(buildSnapshot(existing), proposed);
  await tx.questionOption.deleteMany({ where: { questionId: id } });
  const question = await tx.question.update({
    where: { id },
    data: {
      ...questionColumns(data),
      updatedById: actorId,
      ...(contentChanged ? { version: { increment: 1 } } : {}),
      options: { create: data.options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i })) },
    },
    include: { options: true },
  });
  await recordAudit(
    {
      actorId,
      action: AuditAction.QUESTION_UPDATED,
      entityType: "Question",
      entityId: id,
      metadata: { type: data.type, contentChanged, version: existing.version + (contentChanged ? 1 : 0) },
    },
    tx,
  );
  return question;
}

export async function setQuestionArchived(actor: SessionUser, id: string, archived: boolean) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const existing = await tx.question.findUnique({ where: { id }, select: { isArchived: true } });
    if (!existing) throw new NotFoundError("Question not found.");
    if (existing.isArchived === archived) return;
    await tx.question.update({ where: { id }, data: { isArchived: archived, updatedById: actor.id } });
    await recordAudit(
      {
        actorId: actor.id,
        action: archived ? AuditAction.QUESTION_ARCHIVED : AuditAction.QUESTION_RESTORED,
        entityType: "Question",
        entityId: id,
      },
      tx,
    );
  });
}

/**
 * Permanently delete a question. Only allowed if it has never been placed in an assessment;
 * otherwise it must be deactivated so existing assessments keep their reference.
 */
export async function deleteQuestion(actor: SessionUser, id: string) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const q = await tx.question.findUnique({
      where: { id },
      select: { id: true, type: true, text: true, _count: { select: { assessments: true, paperItems: true } } },
    });
    if (!q) throw new NotFoundError("Question not found.");
    if (q._count.assessments > 0) {
      throw new ConflictError(
        `This question is used in ${q._count.assessments} assessment(s) and cannot be deleted. Deactivate it instead.`,
      );
    }
    if (q._count.paperItems > 0) {
      throw new ConflictError(`This question is used in ${q._count.paperItems} question paper(s) and cannot be deleted. Deactivate it instead.`);
    }
    await tx.question.delete({ where: { id } });
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.QUESTION_DELETED,
        entityType: "Question",
        entityId: id,
        metadata: { type: q.type, text: q.text.slice(0, 200) },
      },
      tx,
    );
  });
}

/** Distinct topics in the bank, for the topic filter. */
export async function listTopics(actor: SessionUser) {
  assertAdmin(actor);
  const rows = await db.question.findMany({
    where: { topic: { not: null } },
    distinct: ["topic"],
    select: { topic: true },
    orderBy: { topic: "asc" },
  });
  return rows.map((r) => r.topic!).filter(Boolean);
}

export async function listCourseOptions() {
  return db.course.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });
}
