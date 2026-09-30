import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, type AssessmentType, type QuestionType } from "@/generated/prisma/enums";
import {
  ASSESSMENT_FIELDS,
  availableActions,
  canEditQuestions,
  checkTransition,
  editableFields,
  FIELD_LABEL,
  isFieldEditable,
  STATUS_LABEL,
  timeBasedStatus,
  type AssessmentField,
  type TransitionContext,
} from "@/lib/assessments/lifecycle";
import { ConflictError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import { buildSnapshot, type QuestionSnapshot } from "@/lib/questions/snapshot";
import { ALL_QUESTION_TYPES, hasOptions, isQuestionCompatible, questionKind } from "@/lib/questions/types";
import {
  assessmentRuleIssues,
  createAssessmentSchema,
  updateAssessmentSchema,
  type AssessmentValues,
} from "@/lib/validation/assessment";
import { marksSchema } from "@/lib/validation/common";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";

// ---------------------------------------------------------------------------
// Time-driven status changes
// ---------------------------------------------------------------------------

/**
 * Apply SCHEDULED → ACTIVE → ENDED moves that are due. Called before every read/mutation of
 * assessments so the stored status is never stale when a decision depends on it.
 */
export async function syncTimeBasedStatuses(now: Date = new Date(), assessmentId?: string) {
  const due = await db.assessment.findMany({
    where: {
      ...(assessmentId ? { id: assessmentId } : {}),
      OR: [
        { status: AssessmentStatus.SCHEDULED, startAt: { lte: now } },
        { status: AssessmentStatus.ACTIVE, endAt: { lte: now } },
      ],
    },
    select: { id: true, status: true, startAt: true, endAt: true },
  });

  for (const a of due) {
    const target = timeBasedStatus(a.status, a.startAt, a.endAt, now);
    if (target === a.status) continue;
    await db.$transaction(async (tx) => {
      const { count } = await tx.assessment.updateMany({ where: { id: a.id, status: a.status }, data: { status: target } });
      if (count === 0) return; // someone else already moved it
      await recordAudit(
        {
          actorId: null,
          action: AuditAction.ASSESSMENT_STATUS_CHANGED,
          entityType: "Assessment",
          entityId: a.id,
          metadata: { from: a.status, to: target, trigger: "system" },
        },
        tx,
      );
    });
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AssessmentListFilters {
  status?: AssessmentStatus;
  q?: string;
  includeArchived?: boolean;
}

export async function listAssessments(actor: SessionUser, filters: AssessmentListFilters = {}) {
  assertAdmin(actor);
  await syncTimeBasedStatuses();

  const where: Prisma.AssessmentWhereInput = {};
  if (filters.status) where.status = filters.status;
  else if (!filters.includeArchived) where.status = { not: AssessmentStatus.ARCHIVED };
  const q = filters.q?.trim();
  if (q) where.name = { contains: q, mode: "insensitive" };

  const [rows, statusCounts] = await Promise.all([
    db.assessment.findMany({
      where,
      orderBy: [{ startAt: "desc" }],
      take: 200,
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        durationMinutes: true,
        course: { select: { code: true, name: true } },
        questions: { select: { marks: true } },
      },
    }),
    db.assessment.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return {
    rows: rows.map(({ questions, ...a }) => ({
      ...a,
      questionCount: questions.length,
      totalMarks: sumMarks(questions),
    })),
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])) as Partial<
      Record<AssessmentStatus, number>
    >,
  };
}

function sumMarks(rows: { marks: Prisma.Decimal }[]) {
  // Sum in hundredths to avoid floating-point drift.
  return rows.reduce((acc, r) => acc + Math.round(r.marks.toNumber() * 100), 0) / 100;
}

const assessmentInclude = {
  course: { select: { id: true, code: true, name: true } },
  createdBy: { select: { name: true } },
  questions: {
    orderBy: { position: "asc" },
    include: {
      question: {
        include: { options: { orderBy: { position: "asc" } } },
      },
    },
  },
} satisfies Prisma.AssessmentInclude;

type AssessmentWithQuestions = Prisma.AssessmentGetPayload<{ include: typeof assessmentInclude }>;

function toContext(a: AssessmentWithQuestions): TransitionContext {
  let objectiveCount = 0;
  let subjectiveCount = 0;
  let incompatibleCount = 0;
  let archivedQuestionCount = 0;
  for (const aq of a.questions) {
    const type = snapshotOf(aq).type;
    if (questionKind(type) === "OBJECTIVE") objectiveCount++;
    else subjectiveCount++;
    if (!isQuestionCompatible(a.type, type)) incompatibleCount++;
    if (a.status === AssessmentStatus.DRAFT && aq.question.isArchived) archivedQuestionCount++;
  }
  return {
    status: a.status,
    type: a.type,
    startAt: a.startAt,
    endAt: a.endAt,
    passingMarks: a.passingMarks.toNumber(),
    totalMarks: sumMarks(a.questions),
    questionCount: a.questions.length,
    objectiveCount,
    subjectiveCount,
    incompatibleCount,
    archivedQuestionCount,
  };
}

type AssessmentQuestionRow = AssessmentWithQuestions["questions"][number];

/**
 * The assessment's own frozen copy is authoritative in every status, including DRAFT.
 * Bank edits only reach an assessment when an admin explicitly pulls the latest version.
 */
function snapshotOf(aq: Pick<AssessmentQuestionRow, "snapshot">): QuestionSnapshot {
  return aq.snapshot as unknown as QuestionSnapshot;
}

async function loadAssessment(tx: DbTx, id: string) {
  const a = await tx.assessment.findUnique({ where: { id }, include: assessmentInclude });
  if (!a) throw new NotFoundError("Assessment not found.");
  return a;
}

export async function getAssessment(actor: SessionUser, id: string, now: Date = new Date()) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);
  const a = await loadAssessment(db, id);
  const ctx = toContext(a);
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    course: a.course,
    type: a.type,
    status: a.status,
    durationMinutes: a.durationMinutes,
    startAt: a.startAt,
    endAt: a.endAt,
    maxAttempts: a.maxAttempts,
    passingMarks: a.passingMarks.toNumber(),
    resultVisibility: a.resultVisibility,
    proctoringEnabled: a.proctoringEnabled,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    scheduledAt: a.scheduledAt,
    publishedAt: a.publishedAt,
    archivedAt: a.archivedAt,
    totals: {
      questionCount: ctx.questionCount,
      totalMarks: ctx.totalMarks,
      objectiveCount: ctx.objectiveCount,
      subjectiveCount: ctx.subjectiveCount,
    },
    questions: a.questions.map((aq) => {
      const content = snapshotOf(aq);
      return {
        id: aq.id,
        questionId: aq.questionId,
        position: aq.position,
        marks: aq.marks.toNumber(),
        negativeMarks: aq.negativeMarks.toNumber(),
        content,
        snapshotVersion: aq.questionVersion,
        latestVersion: aq.question.version,
        /** The bank question has been edited since this copy was taken. */
        hasNewerVersion: aq.question.version > aq.questionVersion,
        isArchived: aq.question.isArchived,
        compatible: isQuestionCompatible(a.type, content.type),
      };
    }),
    actions: availableActions(ctx, now),
    editableFields: editableFields(a.status),
    canEditQuestions: canEditQuestions(a.status),
  };
}

export type AssessmentDetail = Awaited<ReturnType<typeof getAssessment>>;

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

async function assertCourseExists(tx: DbTx, courseId: string) {
  const exists = await tx.course.count({ where: { id: courseId, isActive: true } });
  if (!exists) throw new ValidationError("Please correct the highlighted fields.", { courseId: ["Course not found"] });
}

function toFieldErrors(issues: { path: string; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) (out[i.path] ??= []).push(i.message);
  return out;
}

export async function createAssessment(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const parsed = createAssessmentSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const v = parsed.data;

  return db.$transaction(async (tx) => {
    await assertCourseExists(tx, v.courseId);
    const a = await tx.assessment.create({
      data: { ...v, status: AssessmentStatus.DRAFT, createdById: actor.id },
    });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.ASSESSMENT_CREATED, entityType: "Assessment", entityId: a.id, metadata: { name: a.name } },
      tx,
    );
    return a;
  });
}

function currentValues(a: AssessmentWithQuestions): AssessmentValues {
  return {
    name: a.name,
    description: a.description,
    courseId: a.courseId,
    type: a.type,
    durationMinutes: a.durationMinutes,
    startAt: a.startAt,
    endAt: a.endAt,
    maxAttempts: a.maxAttempts,
    passingMarks: a.passingMarks.toNumber(),
    resultVisibility: a.resultVisibility,
    proctoringEnabled: a.proctoringEnabled,
  };
}

function sameValue(a: unknown, b: unknown) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/**
 * Update settings. Fields omitted from `raw` are left unchanged. Changing a field that the
 * current status locks is rejected (see `editableFields` in the lifecycle module).
 */
export async function updateAssessment(actor: SessionUser, id: string, raw: unknown, now: Date = new Date()) {
  assertAdmin(actor);
  const parsed = updateAssessmentSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  await syncTimeBasedStatuses(now, id);

  return db.$transaction(async (tx) => {
    const a = await loadAssessment(tx, id);
    const before = currentValues(a);
    const changes: Partial<AssessmentValues> = {};
    for (const field of ASSESSMENT_FIELDS) {
      const next = parsed.data[field];
      if (next !== undefined && !sameValue(before[field], next)) {
        (changes as Record<AssessmentField, unknown>)[field] = next;
      }
    }
    const changed = Object.keys(changes) as AssessmentField[];
    if (changed.length === 0) return a;

    const locked = changed.filter((f) => !isFieldEditable(a.status, f));
    if (locked.length) {
      throw new ConflictError(
        `${locked.map((f) => FIELD_LABEL[f]).join(", ")} cannot be changed while the assessment is ${STATUS_LABEL[a.status].toLowerCase()}.`,
      );
    }

    const merged: AssessmentValues = { ...before, ...changes };
    const issues: { path: string; message: string }[] = assessmentRuleIssues(merged);

    if (changes.startAt && a.status === AssessmentStatus.SCHEDULED && changes.startAt.getTime() <= now.getTime()) {
      issues.push({ path: "startAt", message: "Start time must be in the future" });
    }
    if (changes.endAt && a.status === AssessmentStatus.ACTIVE) {
      if (changes.endAt.getTime() < a.endAt.getTime()) issues.push({ path: "endAt", message: "An active assessment's end time can only be extended" });
      else if (changes.endAt.getTime() <= now.getTime()) issues.push({ path: "endAt", message: "End time must be in the future" });
    }
    if (changes.type) {
      const incompatible = a.questions.filter((aq) => !isQuestionCompatible(changes.type!, snapshotOf(aq).type)).length;
      if (incompatible) {
        issues.push({ path: "type", message: `${incompatible} existing question(s) do not fit a ${changes.type.toLowerCase()} assessment. Remove them first.` });
      }
    }
    if (issues.length) throw new ValidationError("Please correct the highlighted fields.", toFieldErrors(issues));
    if (changes.courseId) await assertCourseExists(tx, changes.courseId);

    const { count } = await tx.assessment.updateMany({ where: { id, status: a.status }, data: changes });
    if (count === 0) throw new ConflictError("The assessment changed status while you were editing. Reload and try again.");

    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_UPDATED,
        entityType: "Assessment",
        entityId: id,
        metadata: { fields: changed, status: a.status },
      },
      tx,
    );
    return tx.assessment.findUniqueOrThrow({ where: { id } });
  });
}

// ---------------------------------------------------------------------------
// Question association (DRAFT only)
// ---------------------------------------------------------------------------

/**
 * Lock the assessment row for the rest of the transaction and confirm it is still a draft.
 * The row lock serialises this with a concurrent schedule attempt.
 */
async function lockDraft(tx: DbTx, id: string) {
  const { count } = await tx.assessment.updateMany({
    where: { id, status: AssessmentStatus.DRAFT },
    data: { updatedAt: new Date() },
  });
  if (count === 1) return tx.assessment.findUniqueOrThrow({ where: { id }, select: { id: true, type: true } });
  const exists = await tx.assessment.findUnique({ where: { id }, select: { status: true } });
  if (!exists) throw new NotFoundError("Assessment not found.");
  throw new ConflictError(
    `Questions are locked because the assessment is ${STATUS_LABEL[exists.status].toLowerCase()}. Only draft assessments can be changed.`,
  );
}

async function renumber(tx: DbTx, assessmentId: string, orderedIds: string[]) {
  for (const [i, aqId] of orderedIds.entries()) {
    await tx.assessmentQuestion.update({ where: { id: aqId }, data: { position: i + 1 } });
  }
}

export async function addQuestionsToAssessment(actor: SessionUser, assessmentId: string, questionIds: string[]) {
  assertAdmin(actor);
  const ids = [...new Set(questionIds.filter(Boolean))];
  if (ids.length === 0) throw new ValidationError("Select at least one question to add.");

  return db.$transaction(async (tx) => {
    const assessment = await lockDraft(tx, assessmentId);
    const questions = await tx.question.findMany({
      where: { id: { in: ids } },
      include: { options: { orderBy: { position: "asc" } } },
    });
    if (questions.length !== ids.length) throw new ValidationError("Some selected questions no longer exist.");

    const archived = questions.filter((q) => q.isArchived);
    if (archived.length) throw new ValidationError("Inactive questions cannot be added to an assessment.");

    const incompatible = questions.filter((q) => !isQuestionCompatible(assessment.type, q.type));
    if (incompatible.length) {
      throw new ValidationError(
        `${incompatible.length} selected question(s) do not fit a ${assessment.type.toLowerCase()} assessment.`,
      );
    }

    const existing = await tx.assessmentQuestion.findMany({
      where: { assessmentId },
      select: { questionId: true, position: true },
    });
    const present = new Set(existing.map((e) => e.questionId));
    let position = existing.reduce((m, e) => Math.max(m, e.position), 0);
    // Preserve the order the admin selected them in.
    const toAdd = ids.map((id) => questions.find((q) => q.id === id)!).filter((q) => !present.has(q.id));

    for (const q of toAdd) {
      await tx.assessmentQuestion.create({
        data: {
          assessmentId,
          questionId: q.id,
          position: ++position,
          marks: q.marks,
          negativeMarks: q.negativeMarks,
          snapshot: buildSnapshot(q) as unknown as Prisma.InputJsonValue,
          questionVersion: q.version,
        },
      });
    }

    if (toAdd.length) {
      await recordAudit(
        {
          actorId: actor.id,
          action: AuditAction.ASSESSMENT_QUESTIONS_ADDED,
          entityType: "Assessment",
          entityId: assessmentId,
          metadata: { questionIds: toAdd.map((q) => q.id) },
        },
        tx,
      );
    }
    return { added: toAdd.length, skipped: ids.length - toAdd.length };
  });
}

export async function removeQuestionFromAssessment(actor: SessionUser, assessmentId: string, assessmentQuestionId: string) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    await lockDraft(tx, assessmentId);
    const { count } = await tx.assessmentQuestion.deleteMany({ where: { id: assessmentQuestionId, assessmentId } });
    if (count === 0) throw new NotFoundError("That question is not part of this assessment.");
    const remaining = await tx.assessmentQuestion.findMany({
      where: { assessmentId },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    await renumber(tx, assessmentId, remaining.map((r) => r.id));
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_QUESTION_REMOVED,
        entityType: "Assessment",
        entityId: assessmentId,
        metadata: { assessmentQuestionId },
      },
      tx,
    );
  });
}

export async function moveQuestionInAssessment(
  actor: SessionUser,
  assessmentId: string,
  assessmentQuestionId: string,
  direction: "up" | "down",
) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    await lockDraft(tx, assessmentId);
    const ordered = await tx.assessmentQuestion.findMany({
      where: { assessmentId },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    const ids = ordered.map((o) => o.id);
    const i = ids.indexOf(assessmentQuestionId);
    if (i === -1) throw new NotFoundError("That question is not part of this assessment.");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await renumber(tx, assessmentId, ids);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_QUESTIONS_REORDERED,
        entityType: "Assessment",
        entityId: assessmentId,
        metadata: { order: ids },
      },
      tx,
    );
  });
}

const questionMarksSchema = z
  .object({ marks: marksSchema, negativeMarks: z.preprocess((v) => (v === "" || v == null ? 0 : v), marksSchema) })
  .refine((v) => v.negativeMarks <= v.marks, { path: ["negativeMarks"], message: "Cannot exceed marks" });

export async function updateAssessmentQuestionMarks(
  actor: SessionUser,
  assessmentId: string,
  assessmentQuestionId: string,
  raw: unknown,
) {
  assertAdmin(actor);
  const parsed = questionMarksSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);

  return db.$transaction(async (tx) => {
    await lockDraft(tx, assessmentId);
    const aq = await tx.assessmentQuestion.findFirst({
      where: { id: assessmentQuestionId, assessmentId },
      select: { id: true, snapshot: true },
    });
    if (!aq) throw new NotFoundError("That question is not part of this assessment.");
    if (!hasOptions(snapshotOf(aq).type) && parsed.data.negativeMarks > 0) {
      throw new ValidationError("Please correct the highlighted fields.", { negativeMarks: ["Subjective questions cannot have negative marks"] });
    }
    await tx.assessmentQuestion.update({ where: { id: aq.id }, data: parsed.data });
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_QUESTION_UPDATED,
        entityType: "Assessment",
        entityId: assessmentId,
        metadata: { assessmentQuestionId, ...parsed.data },
      },
      tx,
    );
  });
}

/**
 * Replace a draft assessment's copy of a question with the bank's current version.
 * Marks set on the assessment are kept. Explicit on purpose: bank edits never flow in silently.
 */
export async function refreshAssessmentQuestion(actor: SessionUser, assessmentId: string, assessmentQuestionId: string) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const assessment = await lockDraft(tx, assessmentId);
    const aq = await tx.assessmentQuestion.findFirst({
      where: { id: assessmentQuestionId, assessmentId },
      include: { question: { include: { options: { orderBy: { position: "asc" } } } } },
    });
    if (!aq) throw new NotFoundError("That question is not part of this assessment.");
    if (aq.question.isArchived) throw new ValidationError("This question is inactive in the bank; its latest version cannot be used.");
    if (!isQuestionCompatible(assessment.type, aq.question.type)) {
      throw new ValidationError(`The latest version is a different question type that does not fit a ${assessment.type.toLowerCase()} assessment.`);
    }
    const fromVersion = aq.questionVersion;
    let negativeMarks = aq.negativeMarks;
    // Negative marking is meaningless if the question became subjective.
    if (!hasOptions(aq.question.type)) negativeMarks = new Prisma.Decimal(0);
    await tx.assessmentQuestion.update({
      where: { id: aq.id },
      data: {
        snapshot: buildSnapshot(aq.question) as unknown as Prisma.InputJsonValue,
        questionVersion: aq.question.version,
        negativeMarks,
      },
    });
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_QUESTION_REFRESHED,
        entityType: "Assessment",
        entityId: assessmentId,
        metadata: { assessmentQuestionId, questionId: aq.questionId, fromVersion, toVersion: aq.question.version },
      },
      tx,
    );
  });
}

/** Bank questions that can still be added: active, compatible with the assessment type, not already included. */
export async function listAddableQuestions(
  actor: SessionUser,
  assessmentId: string,
  filters: { q?: string; type?: QuestionType; topic?: string } = {},
) {
  assertAdmin(actor);
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { id: true, name: true, type: true, status: true, questions: { select: { questionId: true } } },
  });
  if (!assessment) throw new NotFoundError("Assessment not found.");

  const allowedTypes = ALL_QUESTION_TYPES.filter((t) => isQuestionCompatible(assessment.type, t));
  const where: Prisma.QuestionWhereInput = {
    isArchived: false,
    id: { notIn: assessment.questions.map((q) => q.questionId) },
    type: filters.type && allowedTypes.includes(filters.type) ? filters.type : { in: allowedTypes },
  };
  const q = filters.q?.trim();
  if (q) where.OR = [{ text: { contains: q, mode: "insensitive" } }, { topic: { contains: q, mode: "insensitive" } }];
  const topic = filters.topic?.trim();
  if (topic) where.topic = { equals: topic, mode: "insensitive" };

  const rows = await db.question.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, type: true, text: true, marks: true, negativeMarks: true, topic: true, difficulty: true },
  });
  return {
    assessment: { id: assessment.id, name: assessment.name, type: assessment.type, status: assessment.status },
    allowedTypes,
    rows: rows.map((r) => ({ ...r, marks: r.marks.toNumber(), negativeMarks: r.negativeMarks.toNumber() })),
  };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export async function transitionAssessment(
  actor: SessionUser,
  id: string,
  to: AssessmentStatus,
  now: Date = new Date(),
) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);

  return db.$transaction(async (tx) => {
    const a = await loadAssessment(tx, id);
    const check = checkTransition(toContext(a), to, { now, trigger: "manual" });
    if (!check.ok) throw new ConflictError(check.reasons.join(" "));

    const data: Prisma.AssessmentUpdateManyMutationInput = { status: to };
    if (to === AssessmentStatus.SCHEDULED) data.scheduledAt = now;
    if (a.status === AssessmentStatus.SCHEDULED && to === AssessmentStatus.DRAFT) data.scheduledAt = null;
    if (a.status === AssessmentStatus.ACTIVE && to === AssessmentStatus.ENDED) data.endAt = now;
    if (to === AssessmentStatus.PUBLISHED) data.publishedAt = now;
    if (to === AssessmentStatus.ARCHIVED) data.archivedAt = now;

    const { count } = await tx.assessment.updateMany({ where: { id, status: a.status }, data });
    if (count === 0) throw new ConflictError("The assessment changed status in the meantime. Reload and try again.");

    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_STATUS_CHANGED,
        entityType: "Assessment",
        entityId: id,
        metadata: { from: a.status, to, trigger: "manual" },
      },
      tx,
    );
    return tx.assessment.findUniqueOrThrow({ where: { id } });
  });
}

export type { AssessmentType };
