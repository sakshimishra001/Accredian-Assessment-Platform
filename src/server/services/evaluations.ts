import "server-only";
import { AttemptStatus, EvaluationStatus, Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { evaluationMarksSchema } from "@/lib/validation/evaluation";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db, type DbTx } from "../db";
import { closeExpiredAttempts } from "./attempts";
import { needsManualMarks } from "./evaluation-status";
import { attemptBreakdown, loadResultAttempt, resultOf } from "./results";

const SUBMITTED = [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED];
const OPEN_FOR_MARKING: EvaluationStatus[] = [EvaluationStatus.PENDING, EvaluationStatus.IN_PROGRESS];

/**
 * A submitted attempt of a candidate assigned to this examiner, for this assessment. Anything else —
 * another examiner's candidate, an unassigned one, an attempt still in progress, a made-up id — is
 * "not found". The assignment is re-checked inside each write transaction.
 */
export async function assertAssigned(tx: DbTx, actor: SessionUser, attemptId: string) {
  const attempt = await tx.assessmentAttempt.findFirst({
    where: { id: attemptId, status: { in: SUBMITTED }, candidate: { examinerId: actor.id } },
    select: { id: true, assessmentId: true },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  return attempt;
}

/** The examiner's queue: their assigned candidates' submitted attempts, with evaluation progress. */
export async function listMyEvaluations(actor: SessionUser, filters: { assessmentId?: string } = {}, now: Date = new Date()) {
  assertRole(actor, Role.EXAMINER);
  if (filters.assessmentId) await closeExpiredAttempts(now, filters.assessmentId);
  const attempts = await db.assessmentAttempt.findMany({
    where: { status: { in: SUBMITTED }, candidate: { examinerId: actor.id }, ...(filters.assessmentId ? { assessmentId: filters.assessmentId } : {}) },
    orderBy: [{ submittedAt: "asc" }],
    select: { id: true },
  });
  const rows = [];
  for (const { id } of attempts) {
    const row = (await loadResultAttempt(db, id))!;
    const result = resultOf(row);
    rows.push({
      attemptId: row.id,
      attemptNumber: row.attemptNumber,
      assessment: { id: row.assessment.id, name: row.assessment.name, status: row.assessment.status },
      learner: row.learner,
      status: row.status,
      submittedAt: row.submittedAt,
      evaluationStatus: row.evaluationStatus,
      answersToMark: result.counts.pending + result.counts.evaluated,
      pending: result.counts.pending,
    });
  }
  return rows;
}

/**
 * One attempt to evaluate: every question with the answer key and marking guidance, the learner's
 * answers, objective scores (read-only) and the marks given so far.
 */
export async function getEvaluation(actor: SessionUser, attemptId: string) {
  assertRole(actor, Role.EXAMINER);
  await assertAssigned(db, actor, attemptId);
  const row = (await loadResultAttempt(db, attemptId))!;
  return { ...attemptBreakdown(row), canEdit: OPEN_FOR_MARKING.includes(row.evaluationStatus) };
}

/**
 * Lock the attempt for marking: it must be submitted, assigned to this examiner and not finalized.
 * The row lock serialises concurrent saves/finalize for the same attempt.
 */
async function lockForMarking(tx: DbTx, actor: SessionUser, attemptId: string) {
  const attempt = await assertAssigned(tx, actor, attemptId);
  const { count } = await tx.assessmentAttempt.updateMany({
    where: { id: attemptId, evaluationStatus: { in: OPEN_FOR_MARKING } },
    data: { evaluationStatus: EvaluationStatus.IN_PROGRESS },
  });
  if (count === 0) throw new ConflictError("This evaluation has been finalized. Ask an administrator to reopen it if marks must change.");
  return attempt;
}

/**
 * Save marks (and optional comments) for written answers. Only subjective questions that were
 * answered can be marked; marks must be between 0 and the question's maximum. Objective scores,
 * maximum marks and the learner's answers are never changed here.
 */
export async function saveEvaluation(actor: SessionUser, attemptId: string, raw: unknown, now: Date = new Date()) {
  assertRole(actor, Role.EXAMINER);
  const parsed = evaluationMarksSchema.safeParse(raw ?? {});
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Some marks couldn’t be saved.");

  return db.$transaction(async (tx) => {
    const attempt = await lockForMarking(tx, actor, attemptId);
    const ids = parsed.data.marks.map((m) => m.assessmentQuestionId);
    const questions = await tx.assessmentQuestion.findMany({
      where: { assessmentId: attempt.assessmentId, id: { in: ids } },
      select: { id: true, marks: true, snapshot: true, responses: { where: { attemptId }, select: { textAnswer: true, _count: { select: { attachments: true } } } } },
    });
    const byId = new Map(questions.map((q) => [q.id, q]));
    const errors: FieldErrors = {};
    parsed.data.marks.forEach((m, i) => {
      const q = byId.get(m.assessmentQuestionId);
      const key = `marks.${i}.awardedMarks`;
      if (!q) return void (errors[`marks.${i}.assessmentQuestionId`] = ["This question is not part of the assessment"]);
      if (!needsManualMarks(q.snapshot as unknown as QuestionSnapshot, q.responses[0]?.textAnswer ?? null, q.responses[0]?._count.attachments ?? 0)) {
        return void (errors[key] = ["Only answered written questions are marked by an examiner"]);
      }
      if (m.awardedMarks > q.marks.toNumber()) errors[key] = [`Marks can’t exceed the maximum of ${q.marks.toNumber()}`];
    });
    if (Object.keys(errors).length) throw new ValidationError("Some marks couldn’t be saved.", errors);

    for (const m of parsed.data.marks) {
      await tx.attemptResponse.update({
        where: { attemptId_assessmentQuestionId: { attemptId, assessmentQuestionId: m.assessmentQuestionId } },
        data: { awardedMarks: m.awardedMarks, examinerComment: m.comment, evaluatedById: actor.id, evaluatedAt: now },
      });
    }
    await recordAudit(
      { actorId: actor.id, action: AuditAction.EVALUATION_SAVED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { questions: ids, marks: parsed.data.marks.map((m) => m.awardedMarks) } },
      tx,
    );
    return { saved: parsed.data.marks.length };
  });
}

/**
 * Finalize: every answered written question must have marks. The attempt's evaluation becomes
 * COMPLETED and its result final; marks are then locked (see reopenEvaluation for corrections).
 */
export async function finalizeEvaluation(actor: SessionUser, attemptId: string, now: Date = new Date()) {
  assertRole(actor, Role.EXAMINER);
  await db.$transaction(async (tx) => {
    await lockForMarking(tx, actor, attemptId);
    const row = (await loadResultAttempt(tx, attemptId))!;
    const result = resultOf({ ...row, evaluationStatus: EvaluationStatus.COMPLETED });
    if (!result.complete) {
      const missing = attemptBreakdown(row).questions.filter((q) => q.outcome === "pending").map((q) => `Q${q.number}`);
      throw new ValidationError(`Enter marks for ${missing.join(", ")} before finalizing.`, { marks: missing.map((m) => `${m} has no marks`) });
    }
    await tx.assessmentAttempt.update({
      where: { id: attemptId },
      data: { evaluationStatus: EvaluationStatus.COMPLETED, evaluationFinalizedAt: now, evaluationFinalizedById: actor.id },
    });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.EVALUATION_FINALIZED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { obtained: result.obtained, maxMarks: result.maxMarks } },
      tx,
    );
  });
}
