import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, AttemptStatus, EvaluationStatus, Role, UserStatus, type AssessmentType, type QuestionType, type SectionAttemptRule } from "@/generated/prisma/enums";
import {
  ASSESSMENT_FIELDS,
  availableActions,
  canEditQuestions,
  checkTransition,
  editableFields,
  FIELD_LABEL,
  isFieldEditable,
  scheduleReadiness,
  STATUS_LABEL,
  timeBasedStatus,
  type AssessmentField,
  type TransitionContext,
} from "@/lib/assessments/lifecycle";
import { APP_TIME_ZONE } from "@/lib/datetime";
import { ConflictError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import { round2, sectionMaxMarks } from "@/lib/papers/rules";
import { paperUsability } from "./question-papers";
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
import { insertBatchCandidates } from "./candidates";

// ---------------------------------------------------------------------------
// Time-driven status changes
// ---------------------------------------------------------------------------

/**
 * Credit an administrator pause (from `pausedAt` until `until`) to the attempts that sat through it:
 * every attempt still in progress that had started by then. Their deadline moves by the paused time
 * and it is added to pausedSeconds (WINDOW-mode deadlines are recomputed from it, still capped at the
 * window end). Rounded up to whole seconds, so a learner never loses a fraction of a second.
 */
export async function creditPause(tx: DbTx, assessmentId: string, pausedAt: Date, until: Date) {
  const seconds = Math.max(0, Math.ceil((until.getTime() - pausedAt.getTime()) / 1000));
  if (seconds === 0) return { seconds, attempts: 0 };
  const attempts = await tx.$executeRaw`
    UPDATE "assessment_attempts"
       SET "pausedSeconds" = "pausedSeconds" + ${seconds}, "deadlineAt" = "deadlineAt" + make_interval(secs => ${seconds}::int)
     WHERE "assessmentId" = ${assessmentId} AND "status" = 'IN_PROGRESS' AND "startedAt" <= ${pausedAt}`;
  return { seconds, attempts };
}

/**
 * Apply SCHEDULED → ACTIVE → ENDED moves that are due (a PAUSED assessment also ends at its end
 * time; the pause up to then is credited to running attempts first). Called before every
 * read/mutation of assessments so the stored status is never stale when a decision depends on it.
 */
export async function syncTimeBasedStatuses(now: Date = new Date(), assessmentId?: string) {
  const due = await db.assessment.findMany({
    where: {
      ...(assessmentId ? { id: assessmentId } : {}),
      OR: [
        { status: AssessmentStatus.SCHEDULED, startAt: { lte: now } },
        { status: { in: [AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED] }, endAt: { lte: now } },
      ],
    },
    select: { id: true, status: true, startAt: true, endAt: true, pausedAt: true },
  });

  for (const a of due) {
    const target = timeBasedStatus(a.status, a.startAt, a.endAt, now);
    if (target === a.status) continue;
    await db.$transaction(async (tx) => {
      const { count } = await tx.assessment.updateMany({ where: { id: a.id, status: a.status }, data: { status: target, pausedAt: null } });
      if (count === 0) return; // someone else already moved it
      // Ended while paused: the pause lasted until the end time (full-duration attempts keep that time).
      if (a.status === AssessmentStatus.PAUSED && a.pausedAt) await creditPause(tx, a.id, a.pausedAt, a.endAt);
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
        courseId: true,
        description: true,
        createdAt: true,
        course: { select: { code: true, name: true } },
        batch: { select: { id: true, name: true, code: true } },
        paper: { select: { id: true, name: true, version: true } },
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

/** Active learner members of a batch: the learners eligible to take its assessments. */
const activeLearnerMembers = { user: { role: Role.LEARNER, status: UserStatus.ACTIVE } } satisfies Prisma.BatchMemberWhereInput;

const assessmentInclude = {
  course: { select: { id: true, code: true, name: true } },
  createdBy: { select: { name: true } },
  paper: { select: { id: true, name: true, version: true, courseId: true } },
  batch: {
    select: { id: true, name: true, code: true, isActive: true, courseId: true, _count: { select: { members: { where: activeLearnerMembers } } } },
  },
  questions: {
    orderBy: { position: "asc" },
    include: {
      question: {
        include: { options: { orderBy: { position: "asc" } } },
      },
      paperQuestion: {
        select: { id: true, parentId: true, section: { select: { id: true, title: true, position: true, attemptRule: true, attemptCount: true } } },
      },
    },
  },
} satisfies Prisma.AssessmentInclude;

type AssessmentWithQuestions = Prisma.AssessmentGetPayload<{ include: typeof assessmentInclude }>;

/**
 * Maximum marks of a paper-based assessment: per section, the paper's attempt rule applied to its
 * top-level items (a case/passage counts as one item worth the sum of its sub-questions).
 */
function paperTotalMarks(questions: AssessmentWithQuestions["questions"]): number {
  const sections = new Map<string, { rule: SectionAttemptRule; count: number | null; items: Map<string, number> }>();
  for (const aq of questions) {
    const pq = aq.paperQuestion;
    if (!pq) continue;
    const s = sections.get(pq.section.id) ?? { rule: pq.section.attemptRule, count: pq.section.attemptCount, items: new Map() };
    const itemKey = pq.parentId ?? pq.id;
    s.items.set(itemKey, (s.items.get(itemKey) ?? 0) + aq.marks.toNumber());
    sections.set(pq.section.id, s);
  }
  return round2([...sections.values()].reduce((sum, s) => sum + sectionMaxMarks(s.rule, s.count, [...s.items.values()]), 0));
}

interface AttemptCounts {
  openAttemptCount: number;
  pendingEvaluationCount: number;
}

/**
 * Running attempts and submitted-but-not-evaluated attempts, after closing attempts whose deadline
 * has passed (so a finished window never looks "in progress").
 */
async function attemptCounts(tx: DbTx, assessmentId: string, now: Date): Promise<AttemptCounts> {
  // Imported lazily: the attempts service itself depends on this module.
  const { closeExpiredAttempts } = await import("./attempts");
  await closeExpiredAttempts(now, assessmentId);
  const [openAttemptCount, pendingEvaluationCount] = await Promise.all([
    tx.assessmentAttempt.count({ where: { assessmentId, status: AttemptStatus.IN_PROGRESS } }),
    tx.assessmentAttempt.count({ where: { assessmentId, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] }, evaluationStatus: { not: EvaluationStatus.COMPLETED } } }),
  ]);
  return { openAttemptCount, pendingEvaluationCount };
}

function toContext(a: AssessmentWithQuestions, counts: AttemptCounts = { openAttemptCount: 0, pendingEvaluationCount: 0 }): TransitionContext {
  let objectiveCount = 0;
  let subjectiveCount = 0;
  let incompatibleCount = 0;
  let archivedQuestionCount = 0;
  for (const aq of a.questions) {
    const type = snapshotOf(aq).type;
    if (questionKind(type) === "OBJECTIVE") objectiveCount++;
    else subjectiveCount++;
    if (!isQuestionCompatible(a.type, type)) incompatibleCount++;
    // Paper content is frozen in the assessment; archiving a bank question doesn't affect it.
    if (a.status === AssessmentStatus.DRAFT && !aq.paperQuestionId && aq.question.isArchived) archivedQuestionCount++;
  }
  return {
    status: a.status,
    type: a.type,
    startAt: a.startAt,
    endAt: a.endAt,
    passingMarks: a.passingMarks.toNumber(),
    totalMarks: a.paperId ? paperTotalMarks(a.questions) : sumMarks(a.questions),
    questionCount: a.questions.length,
    objectiveCount,
    subjectiveCount,
    incompatibleCount,
    archivedQuestionCount,
    paper: a.paper ? {} : null,
    batch: a.batch ? { active: a.batch.isActive, learnerCount: a.batch._count.members } : null,
    ...counts,
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
  const ctx = toContext(a, await attemptCounts(db, id, now));
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    course: a.course,
    paper: a.paper ? { id: a.paper.id, name: a.paper.name, version: a.paper.version } : null,
    batch: a.batch ? { id: a.batch.id, name: a.batch.name, code: a.batch.code, isActive: a.batch.isActive, learnerCount: a.batch._count.members } : null,
    type: a.type,
    status: a.status,
    durationMinutes: a.durationMinutes,
    startAt: a.startAt,
    endAt: a.endAt,
    /** All times are stored in UTC and entered/shown in this zone. */
    timeZone: APP_TIME_ZONE,
    maxAttempts: a.maxAttempts,
    passingMarks: a.passingMarks.toNumber(),
    resultVisibility: a.resultVisibility,
    resultDetail: a.resultDetail,
    proctoringEnabled: a.proctoringEnabled,
    settings: {
      timingMode: a.timingMode,
      randomizeQuestions: a.randomizeQuestions,
      randomizeOptions: a.randomizeOptions,
      allowResume: a.allowResume,
      showQuestionPalette: a.showQuestionPalette,
      allowMarkForReview: a.allowMarkForReview,
      negativeMarking: a.negativeMarking,
      calculatorEnabled: a.calculatorEnabled,
      calculatorType: a.calculatorType,
      spellCheckEnabled: a.spellCheckEnabled,
      focusMonitoringEnabled: a.focusMonitoringEnabled,
      focusMaxViolations: a.focusMaxViolations,
      focusViolationAction: a.focusViolationAction,
      fullscreenEnabled: a.fullscreenEnabled,
      clipboardMonitoringEnabled: a.clipboardMonitoringEnabled,
      cameraRequired: a.cameraRequired,
      faceDetectionEnabled: a.faceDetectionEnabled,
      multipleFaceDetectionEnabled: a.multipleFaceDetectionEnabled,
      faceMissingDetectionEnabled: a.faceMissingDetectionEnabled,
      cameraSnapshotsEnabled: a.cameraSnapshotsEnabled,
      screenMonitoringEnabled: a.screenMonitoringEnabled,
    },
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
        /** Where the question sits in the question paper (paper-based assessments only). */
        paperSection: aq.paperQuestion ? { id: aq.paperQuestion.section.id, title: aq.paperQuestion.section.title } : null,
        paperParentId: aq.paperQuestion?.parentId ?? null,
      };
    }),
    /** What still blocks publishing (empty when ready). Only meaningful for drafts. */
    publishIssues: a.status === AssessmentStatus.DRAFT ? scheduleReadiness(ctx, now) : [],
    actions: availableActions(ctx, now),
    editableFields: editableFields(a.status),
    canEditQuestions: canEditQuestions(a.status),
  };
}

export type AssessmentDetail = Awaited<ReturnType<typeof getAssessment>>;

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

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

  const { courseId: legacyCourseId, ...values } = v;
  return db.$transaction(async (tx) => {
    const { courseId: batchCourseId } = await assertPaperAndBatch(tx, values);
    // No course is chosen: the assessment belongs to its batch's course (kept for course-based views).
    const courseId = batchCourseId ?? legacyCourseId;
    if (!batchCourseId && legacyCourseId && !(await tx.course.count({ where: { id: legacyCourseId, isActive: true } }))) {
      throw new ValidationError("Please correct the highlighted fields.", { courseId: ["Course not found"] });
    }
    const a = await tx.assessment.create({
      data: { ...values, courseId: courseId!, status: AssessmentStatus.DRAFT, createdById: actor.id },
    });
    if (v.paperId) await copyPaperQuestions(tx, a.id, v.paperId);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ASSESSMENT_CREATED,
        entityType: "Assessment",
        entityId: a.id,
        metadata: { name: a.name, paperId: values.paperId, batchId: values.batchId },
      },
      tx,
    );
    return a;
  });
}

/**
 * The paper must be complete (no approval is needed — see paperReadinessIssues) and the batch
 * active. No course is involved: any complete paper can be used with any batch. Returns the
 * batch's course (the assessment's course follows its batch).
 */
async function assertPaperAndBatch(tx: DbTx, v: { paperId: string | null; batchId: string | null }) {
  const errors: FieldErrors = {};
  let courseId: string | null = null;
  if (v.paperId) {
    const paper = await paperUsability(tx, v.paperId);
    if (!paper) errors.paperId = ["Question paper not found"];
    else if (paper.issues.length) errors.paperId = [`This question paper is incomplete: ${paper.issues.join(" ")}`];
  }
  if (v.batchId) {
    const batch = await tx.batch.findUnique({ where: { id: v.batchId }, select: { isActive: true, courseId: true } });
    if (!batch) errors.batchId = ["Batch not found"];
    else if (!batch.isActive) errors.batchId = ["This batch is inactive"];
    else courseId = batch.courseId;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors.paperId?.[0] ?? errors.batchId?.[0] ?? "Please correct the highlighted fields.", errors);
  return { courseId };
}

/**
 * Freeze the paper's questions into the assessment, in paper order (sections, then items, sub-
 * questions after their case). Copies the paper's own snapshots — the reviewed and approved
 * content — via the existing AssessmentQuestion snapshot model.
 */
async function copyPaperQuestions(tx: DbTx, assessmentId: string, paperId: string) {
  await tx.assessmentQuestion.deleteMany({ where: { assessmentId } });
  // One read of every item, in paper order (sections, then position) — and one insert below. The
  // statements run inside the caller's interactive transaction, so their number (each a network
  // round trip to the database) is what decides how long it takes, not the number of questions.
  const items = await tx.paperQuestion.findMany({
    where: { paperId },
    orderBy: [{ section: { position: "asc" } }, { position: "asc" }],
    select: { id: true, sectionId: true, parentId: true, questionId: true, marks: true, negativeMarks: true, snapshot: true, questionVersion: true },
  });
  const rows: Prisma.AssessmentQuestionCreateManyInput[] = [];
  for (const top of items.filter((i) => i.parentId === null)) {
    // A case / passage contributes its sub-questions (in their order); its own row holds no question.
    // Each copy keeps paperQuestionId, so its section and case stay linked through the paper.
    const questions = top.questionId ? [top] : items.filter((i) => i.parentId === top.id);
    for (const row of questions) {
      rows.push({
        assessmentId,
        questionId: row.questionId!,
        paperQuestionId: row.id,
        position: rows.length + 1,
        marks: row.marks ?? 0,
        negativeMarks: row.negativeMarks,
        snapshot: row.snapshot as Prisma.InputJsonValue,
        questionVersion: row.questionVersion ?? 1,
      });
    }
  }
  if (rows.length) await tx.assessmentQuestion.createMany({ data: rows });
}

function currentValues(a: Prisma.AssessmentGetPayload<object>): AssessmentValues {
  return {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    paperId: a.paperId,
    batchId: a.batchId,
    type: a.type,
    durationMinutes: a.durationMinutes,
    startAt: a.startAt,
    endAt: a.endAt,
    maxAttempts: a.maxAttempts,
    passingMarks: a.passingMarks.toNumber(),
    resultVisibility: a.resultVisibility,
    resultDetail: a.resultDetail,
    proctoringEnabled: a.proctoringEnabled,
    timingMode: a.timingMode,
    randomizeQuestions: a.randomizeQuestions,
    randomizeOptions: a.randomizeOptions,
    allowResume: a.allowResume,
    showQuestionPalette: a.showQuestionPalette,
    allowMarkForReview: a.allowMarkForReview,
    negativeMarking: a.negativeMarking,
    calculatorEnabled: a.calculatorEnabled,
    calculatorType: a.calculatorType,
    spellCheckEnabled: a.spellCheckEnabled,
    focusMonitoringEnabled: a.focusMonitoringEnabled,
    focusMaxViolations: a.focusMaxViolations,
    focusViolationAction: a.focusViolationAction,
    fullscreenEnabled: a.fullscreenEnabled,
    clipboardMonitoringEnabled: a.clipboardMonitoringEnabled,
    cameraRequired: a.cameraRequired,
    faceDetectionEnabled: a.faceDetectionEnabled,
    multipleFaceDetectionEnabled: a.multipleFaceDetectionEnabled,
    faceMissingDetectionEnabled: a.faceMissingDetectionEnabled,
    cameraSnapshotsEnabled: a.cameraSnapshotsEnabled,
    screenMonitoringEnabled: a.screenMonitoringEnabled,
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
    const a = await tx.assessment.findUnique({ where: { id }, include: { questions: { select: { snapshot: true } } } });
    if (!a) throw new NotFoundError("Assessment not found.");
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
    // A new paper replaces the questions, so compatibility is checked against it at publish time.
    if (changes.type && changes.paperId === undefined) {
      const incompatible = a.questions.filter((aq) => !isQuestionCompatible(changes.type!, snapshotOf(aq).type)).length;
      if (incompatible) {
        issues.push({ path: "type", message: `${incompatible} existing question(s) do not fit a ${changes.type.toLowerCase()} assessment. Remove them first.` });
      }
    }
    if (issues.length) throw new ValidationError("Please correct the highlighted fields.", toFieldErrors(issues));
    // A new batch brings its course with it (kept for course-based views; never chosen directly).
    const { courseId } = changes.paperId !== undefined || changes.batchId !== undefined ? await assertPaperAndBatch(tx, merged) : { courseId: null };
    if (changes.paperId !== undefined && !a.paperId && a.questions.length) {
      throw new ConflictError("Remove the individually added questions before selecting a question paper.");
    }

    const { count } = await tx.assessment.updateMany({ where: { id, status: a.status }, data: { ...changes, ...(changes.batchId && courseId ? { courseId } : {}) } });
    if (count === 0) throw new ConflictError("The assessment changed status while you were editing. Reload and try again.");
    if (changes.paperId !== undefined) {
      if (changes.paperId) await copyPaperQuestions(tx, id, changes.paperId);
      else await tx.assessmentQuestion.deleteMany({ where: { assessmentId: id } });
    }

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
  if (count === 1) return tx.assessment.findUniqueOrThrow({ where: { id }, select: { id: true, type: true, paperId: true } });
  const exists = await tx.assessment.findUnique({ where: { id }, select: { status: true } });
  if (!exists) throw new NotFoundError("Assessment not found.");
  throw new ConflictError(
    `Questions are locked because the assessment is ${STATUS_LABEL[exists.status].toLowerCase()}. Only draft assessments can be changed.`,
  );
}

/** Draft lock for picking/editing individual bank questions — not for paper-based assessments. */
async function lockManualDraft(tx: DbTx, id: string) {
  const a = await lockDraft(tx, id);
  if (a.paperId) {
    throw new ConflictError("This assessment’s questions come from its question paper. Select another paper (or a newer version of it) to change them.");
  }
  return a;
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
    const assessment = await lockManualDraft(tx, assessmentId);
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
    await lockManualDraft(tx, assessmentId);
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
    await lockManualDraft(tx, assessmentId);
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
    await lockManualDraft(tx, assessmentId);
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
    const assessment = await lockManualDraft(tx, assessmentId);
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

  const counts = to === AssessmentStatus.RESULT_READY ? await attemptCounts(db, id, now) : undefined;
  return db.$transaction(async (tx) => (await applyTransition(tx, actor, id, to, now, counts)).after);
}

/** Check and apply one manual status change inside a transaction (the lifecycle decides what is allowed). */
async function applyTransition(tx: DbTx, actor: SessionUser, id: string, to: AssessmentStatus, now: Date, counts?: AttemptCounts) {
  const a = await loadAssessment(tx, id);
  const check = checkTransition(toContext(a, counts), to, { now, trigger: "manual" });
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
  // The two moments that expose something to learners get their own, easy-to-find entries.
  if (a.status === AssessmentStatus.DRAFT && to === AssessmentStatus.SCHEDULED) {
    await recordAudit({ actorId: actor.id, action: AuditAction.ASSESSMENT_PUBLISHED, entityType: "Assessment", entityId: id, metadata: { startAt: a.startAt.toISOString() } }, tx);
  }
  if (to === AssessmentStatus.PUBLISHED) {
    await recordAudit({ actorId: actor.id, action: AuditAction.RESULTS_PUBLISHED, entityType: "Assessment", entityId: id, metadata: { from: a.status } }, tx);
  }
  return { before: a, after: await tx.assessment.findUniqueOrThrow({ where: { id } }) };
}

/**
 * The learners eligible for an assessment: active learner members of its batch, derived live from
 * BatchMember (no copies). Later milestones turn these into candidates with exam credentials.
 */
export async function listAssessmentLearners(actor: SessionUser, id: string) {
  assertAdmin(actor);
  const a = await db.assessment.findUnique({ where: { id }, select: { batchId: true } });
  if (!a) throw new NotFoundError("Assessment not found.");
  if (!a.batchId) return [];
  const members = await db.batchMember.findMany({
    where: { batchId: a.batchId, ...activeLearnerMembers },
    orderBy: { user: { name: "asc" } },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  return members.map((m) => m.user);
}

/**
 * Review & Publish: DRAFT → SCHEDULED through the existing lifecycle. Fails with every unmet
 * prerequisite (a question paper, valid batch, questions/marks, schedule in the future, …). The
 * assessment then opens and closes by the server clock (see syncTimeBasedStatuses).
 */
export async function publishAssessment(actor: SessionUser, id: string, now: Date = new Date()) {
  return transitionAssessment(actor, id, AssessmentStatus.SCHEDULED, now);
}

/**
 * The Review & Publish step: publish (DRAFT → SCHEDULED, with every lifecycle check) and, in the
 * same transaction, make the batch's active learners candidates of the assessment. Learners already
 * assigned are kept. Returns the assessment and the number of candidates added.
 */
export async function publishAssessmentForBatch(actor: SessionUser, id: string, now: Date = new Date()) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);
  return db.$transaction(async (tx) => {
    const { before, after } = await applyTransition(tx, actor, id, AssessmentStatus.SCHEDULED, now);
    // The lifecycle check above guarantees an active batch with active learners.
    const candidatesAdded = await insertBatchCandidates(tx, actor.id, { id }, before.batchId!, { activeOnly: true });
    return { assessment: after, candidatesAdded };
  });
}

export type { AssessmentType };
