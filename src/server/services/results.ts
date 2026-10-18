import "server-only";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import type { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, AttemptStatus, EvaluationStatus, ResultDetail, ResultVisibility, Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { answerKey } from "@/lib/scoring/objective";
import { calculateAttemptResult, type AttemptResult, type ResultQuestionInput } from "@/lib/scoring/result";
import { reopenEvaluationSchema } from "@/lib/validation/evaluation";
import { AuditAction, recordAudit } from "../audit";
import { forAssessment, type SessionUser } from "../auth/session";
import { assertAdmin, assertRole } from "../authz";
import { db, type DbTx } from "../db";
import { recentlyRecorded } from "../security/recent";
import { closeExpiredAttempts } from "./attempts";
import { needsManualMarks } from "./evaluation-status";

// ---------------------------------------------------------------------------
// Loading + the one calculation
// ---------------------------------------------------------------------------

export const resultAttemptSelect = {
  id: true,
  assessmentId: true,
  learnerId: true,
  attemptNumber: true,
  status: true,
  startedAt: true,
  submittedAt: true,
  pausedSeconds: true,
  evaluationStatus: true,
  evaluationFinalizedAt: true,
  evaluationFinalizedBy: { select: { id: true, name: true } },
  terminatedAt: true,
  terminationReason: true,
  terminatedBy: { select: { id: true, name: true } },
  focusViolations: true,
  lockedAt: true,
  learner: { select: { id: true, name: true, email: true } },
  candidate: { select: { examinerId: true } },
  assessment: {
    select: {
      id: true,
      name: true,
      status: true,
      startAt: true,
      endAt: true,
      durationMinutes: true,
      publishedAt: true,
      resultVisibility: true,
      resultDetail: true,
      passingMarks: true,
      negativeMarking: true,
      focusMonitoringEnabled: true,
      focusMaxViolations: true,
      focusViolationAction: true,
      batch: { select: { id: true, name: true } },
      questions: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          marks: true,
          negativeMarks: true,
          snapshot: true,
          paperQuestion: {
            select: {
              id: true,
              parentId: true,
              parent: { select: { snapshot: true } },
              section: { select: { id: true, title: true, attemptRule: true, attemptCount: true } },
            },
          },
        },
      },
    },
  },
  responses: {
    select: {
      assessmentQuestionId: true,
      selectedOptionIds: true,
      textAnswer: true,
      awardedMarks: true,
      examinerComment: true,
      evaluatedAt: true,
      evaluatedBy: { select: { id: true, name: true } },
      attachments: { orderBy: { createdAt: "asc" }, select: { file: { select: { id: true, fileName: true, extension: true, sizeBytes: true } } } },
    },
  },
} satisfies Prisma.AssessmentAttemptSelect;

export type ResultAttemptRow = Prisma.AssessmentAttemptGetPayload<{ select: typeof resultAttemptSelect }>;

export async function loadResultAttempt(tx: DbTx, attemptId: string) {
  return tx.assessmentAttempt.findUnique({ where: { id: attemptId }, select: resultAttemptSelect });
}

/** Inputs for `calculateAttemptResult`, straight from the frozen assessment content and saved answers. */
export function resultInputs(row: ResultAttemptRow): ResultQuestionInput[] {
  const responses = new Map(row.responses.map((r) => [r.assessmentQuestionId, r]));
  return row.assessment.questions.map((aq) => {
    const r = responses.get(aq.id);
    const pq = aq.paperQuestion;
    return {
      assessmentQuestionId: aq.id,
      snapshot: aq.snapshot as unknown as QuestionSnapshot,
      marks: aq.marks.toNumber(),
      negativeMarks: row.assessment.negativeMarking ? aq.negativeMarks.toNumber() : 0,
      section: pq ? { id: pq.section.id, attemptRule: pq.section.attemptRule, attemptCount: pq.section.attemptCount } : null,
      itemKey: pq?.parentId ?? aq.id,
      response: r ? { selectedOptionIds: r.selectedOptionIds, textAnswer: r.textAnswer, awardedMarks: r.awardedMarks?.toNumber() ?? null, hasFiles: r.attachments.length > 0 } : null,
    };
  });
}

/** The authoritative result for an attempt. Not final until the evaluation is COMPLETED. */
export function resultOf(row: ResultAttemptRow): AttemptResult & { final: boolean; passed: boolean | null } {
  const result = calculateAttemptResult(resultInputs(row));
  const final = row.status !== AttemptStatus.IN_PROGRESS && row.evaluationStatus === EvaluationStatus.COMPLETED && result.complete;
  return { ...result, final, passed: final && result.obtained !== null ? result.obtained >= row.assessment.passingMarks.toNumber() : null };
}

/** Question numbers as learners see them: 1, 2, 3(a), 3(b)… */
export function numbering(row: Pick<ResultAttemptRow, "assessment">) {
  const numbers = new Map<string, string>();
  const groups = new Map<string, { number: string; children: number }>();
  let n = 0;
  for (const aq of row.assessment.questions) {
    const parentId = aq.paperQuestion?.parentId;
    if (!parentId) {
      numbers.set(aq.id, String(++n));
      continue;
    }
    const g = groups.get(parentId) ?? { number: String(++n), children: 0 };
    groups.set(parentId, g);
    numbers.set(aq.id, `${g.number}(${String.fromCharCode(97 + g.children++)})`);
  }
  return numbers;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type LearnerResultState = "IN_PROGRESS" | "TERMINATED" | "EVALUATION_PENDING" | "AWAITING_PUBLICATION" | "AVAILABLE";

/**
 * Existing meaning of ResultVisibility: ON_PUBLISH — once the admin publishes results (assessment
 * reaches PUBLISHED; publishedAt is kept through ARCHIVED). IMMEDIATE — as soon as this attempt's
 * result is final (only allowed for objective assessments, which are final on submission).
 */
export function learnerResultState(row: ResultAttemptRow, final: boolean): LearnerResultState {
  if (row.status === AttemptStatus.IN_PROGRESS) return "IN_PROGRESS";
  // Ended by an administrator: not a submission, so there is no result to show.
  if (row.status === AttemptStatus.TERMINATED) return "TERMINATED";
  if (!final) return "EVALUATION_PENDING";
  if (row.assessment.resultVisibility === ResultVisibility.IMMEDIATE) return "AVAILABLE";
  return row.assessment.publishedAt ? "AVAILABLE" : "AWAITING_PUBLICATION";
}

/**
 * A question's evaluation status as learners see it, from the scoring outcome and the awarded marks:
 * a written answer marked above 0 but below full marks is "partially correct".
 */
export type AnswerStatus = "CORRECT" | "INCORRECT" | "PARTIALLY_CORRECT" | "UNANSWERED" | "EVALUATED" | "PENDING_EVALUATION";

export function answerStatus(q: Pick<AttemptResult["questions"][number], "outcome" | "awarded" | "maxMarks">): AnswerStatus {
  switch (q.outcome) {
    case "correct":
      return "CORRECT";
    case "incorrect":
      return "INCORRECT";
    case "unanswered":
      return "UNANSWERED";
    case "pending":
      return "PENDING_EVALUATION";
    case "evaluated":
      return q.awarded !== null && q.awarded > 0 && q.awarded < q.maxMarks ? "PARTIALLY_CORRECT" : "EVALUATED";
  }
}

/** Time spent in the exam: start to submission (or termination), minus administrator pauses. */
export function timeTakenSeconds(row: Pick<ResultAttemptRow, "startedAt" | "submittedAt" | "terminatedAt" | "pausedSeconds">) {
  const endedAt = row.submittedAt ?? row.terminatedAt;
  return endedAt ? Math.max(0, Math.round((endedAt.getTime() - row.startedAt.getTime()) / 1000) - row.pausedSeconds) : null;
}

/**
 * What a learner may see, by resultDetail: SCORE — totals only. SCORE_AND_ANSWERS — plus each
 * question's marks, their answer and the correct option(s). FULL_FEEDBACK — plus examiner comments
 * and the model answer / explanation. Who sat it and when is always shown; marks only once visible.
 */
function learnerView(row: ResultAttemptRow) {
  const result = resultOf(row);
  const state = learnerResultState(row, result.final);
  const base = {
    attemptId: row.id,
    attemptNumber: row.attemptNumber,
    status: row.status,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    terminatedAt: row.terminatedAt,
    /** Time spent in the exam: start to submission, minus administrator pauses. */
    timeTakenSeconds: timeTakenSeconds(row),
    resultState: state,
  };
  if (state !== "AVAILABLE") return { ...base, result: null };

  const statuses = result.questions.map(answerStatus);
  const passingMarks = row.assessment.passingMarks.toNumber();
  const summary = {
    maxMarks: result.maxMarks,
    obtained: result.obtained!,
    percentage: result.percentage!,
    /** Pass/fail only when the assessment sets passing marks (above 0). */
    passingMarks: passingMarks > 0 ? passingMarks : null,
    passed: passingMarks > 0 ? result.passed : null,
    questionCount: result.counts.questions,
    answered: result.counts.answered,
    unanswered: result.counts.unanswered,
    correct: result.counts.correct,
    incorrect: result.counts.incorrect,
    partiallyCorrect: statuses.filter((s) => s === "PARTIALLY_CORRECT").length,
    evaluated: result.counts.evaluated,
  };
  const detail = row.assessment.resultDetail;
  if (detail === ResultDetail.SCORE) return { ...base, result: { ...summary, questions: null } };

  const numbers = numbering(row);
  const responses = new Map(row.responses.map((r) => [r.assessmentQuestionId, r]));
  const questions = row.assessment.questions.map((aq, i) => {
    const snap = aq.snapshot as unknown as QuestionSnapshot;
    const qr = result.questions[i];
    const r = responses.get(aq.id);
    const parent = aq.paperQuestion?.parent?.snapshot as unknown as QuestionSnapshot | undefined;
    return {
      number: numbers.get(aq.id)!,
      section: aq.paperQuestion?.section.title ?? null,
      type: snap.type,
      /** The case study a sub-question belongs to. */
      caseText: parent?.text ?? null,
      text: snap.text,
      options: snap.options.map((o) => ({ id: o.id, text: o.text })),
      maxMarks: qr.maxMarks,
      awarded: qr.awarded,
      outcome: qr.outcome,
      status: statuses[i],
      yourAnswer: { selectedOptionIds: r?.selectedOptionIds ?? [], textAnswer: r?.textAnswer ?? null, files: (r?.attachments ?? []).map((a) => a.file) },
      correctOptionIds: qr.kind === "objective" ? answerKey(snap) : null,
      ...(detail === ResultDetail.FULL_FEEDBACK ? { examinerComment: r?.examinerComment ?? null, explanation: snap.guidance } : {}),
    };
  });
  return { ...base, result: { ...summary, questions } };
}

// ---------------------------------------------------------------------------
// Learner
// ---------------------------------------------------------------------------

/** A learner acting on one assessment (the route's — see forAssessment). */
function assertExamSession(actor: SessionUser): asserts actor is SessionUser & { assessmentId: string } {
  assertRole(actor, Role.LEARNER);
  if (!actor.assessmentId) throw new ForbiddenError();
}

/** The learner's attempts at one assessment (the request's), each with its result if visible. */
export async function getMyResults(actor: SessionUser, now: Date = new Date()) {
  assertExamSession(actor);
  await closeExpiredAttempts(now, actor.assessmentId);
  const ids = await db.assessmentAttempt.findMany({
    where: { learnerId: actor.id, assessmentId: actor.assessmentId },
    orderBy: { attemptNumber: "asc" },
    select: { id: true },
  });
  const rows = await Promise.all(ids.map((r) => loadResultAttempt(db, r.id)));
  const assessment = rows[0]?.assessment ?? (await db.assessment.findUniqueOrThrow({ where: { id: actor.assessmentId }, select: { id: true, name: true } }));
  return { assessment: { id: assessment.id, name: assessment.name }, attempts: rows.filter((r): r is ResultAttemptRow => !!r).map(learnerView) };
}

/** Audit a result being looked at (at most once per viewer and attempt every 10 minutes). */
async function auditResultView(actor: SessionUser, attemptId: string, assessmentId: string) {
  if (recentlyRecorded(`result:${actor.id}:${attemptId}`)) return;
  await recordAudit({ actorId: actor.id, action: AuditAction.RESULT_VIEWED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { assessmentId, viewerRole: actor.role } });
}

/**
 * The learner's attempts across all their assessments (newest assessment first), each with its
 * result if visible — the learner's Results page.
 */
export async function listMyResults(actor: SessionUser, now: Date = new Date()) {
  assertRole(actor, Role.LEARNER);
  const assessments = await db.assessment.findMany({
    where: { attempts: { some: { learnerId: actor.id } } },
    orderBy: { startAt: "desc" },
    select: { id: true },
  });
  return Promise.all(assessments.map((a) => getMyResults(forAssessment(actor, a.id), now)));
}

/** One of the learner's own attempts (in whichever assessment). Another learner's id is "not found". */
export async function getMyResult(actor: SessionUser, attemptId: string, now: Date = new Date()) {
  assertRole(actor, Role.LEARNER);
  const own = await db.assessmentAttempt.findFirst({ where: ownAttemptWhere(actor.id, attemptId), select: { assessmentId: true } });
  if (!own) throw new NotFoundError("Result not found.");
  await closeExpiredAttempts(now, own.assessmentId);
  const row = await loadResultAttempt(db, attemptId);
  if (!row) throw new NotFoundError("Result not found.");
  const view = learnerView(row);
  if (view.result) await auditResultView(actor, attemptId, row.assessmentId);
  return {
    assessment: { id: row.assessment.id, name: row.assessment.name, startAt: row.assessment.startAt, endAt: row.assessment.endAt, durationMinutes: row.assessment.durationMinutes },
    // From the session's own attempt: the learner's login identifier is their email.
    candidate: { name: row.learner.name, email: row.learner.email },
    ...view,
  };
}

// ---------------------------------------------------------------------------
// Result Published emails
// ---------------------------------------------------------------------------

/**
 * Each active learner's own result as it is now visible to them — for the Result Published email.
 * A learner's result is their best final attempt (as on the results pages); learners whose result
 * isn't available to them (still in progress, pending evaluation, awaiting publication, or only a
 * terminated attempt) are left out. Three queries whatever the number of learners.
 */
export async function visibleResultsForEmail(assessmentId: string) {
  const { assessment: assessmentSelect, ...attemptSelect } = resultAttemptSelect;
  const assessment = await db.assessment.findUnique({ where: { id: assessmentId }, select: assessmentSelect.select });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  const attempts = await db.assessmentAttempt.findMany({
    where: { assessmentId, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] }, learner: { status: UserStatus.ACTIVE } },
    orderBy: { attemptNumber: "asc" },
    select: attemptSelect,
  });
  const passingMarks = assessment.passingMarks.toNumber();
  const best = new Map<string, { row: ResultAttemptRow; result: ReturnType<typeof resultOf> }>();
  for (const a of attempts) {
    const row = { ...a, assessment } as ResultAttemptRow;
    const result = resultOf(row);
    if (learnerResultState(row, result.final) !== "AVAILABLE") continue;
    const current = best.get(a.learnerId);
    if (!current || result.obtained! > current.result.obtained!) best.set(a.learnerId, { row, result });
  }
  return [...best.values()].map(({ row, result }) => ({
    attemptId: row.id,
    learner: row.learner,
    maxMarks: result.maxMarks,
    obtained: result.obtained!,
    percentage: result.percentage!,
    /** Only when the assessment sets passing marks. */
    passed: passingMarks > 0 ? result.passed : null,
  }));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Every candidate of an assessment with their attempts, evaluation status and marks. */
export async function listAssessmentResults(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  assertAdmin(actor);
  await closeExpiredAttempts(now, assessmentId);
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: {
      id: true,
      name: true,
      status: true,
      resultVisibility: true,
      publishedAt: true,
      batch: { select: { id: true, name: true } },
      candidates: {
        orderBy: { learner: { name: "asc" } },
        select: { id: true, learner: { select: { id: true, name: true, email: true } }, examiner: { select: { id: true, name: true } }, attempts: { select: { id: true }, orderBy: { attemptNumber: "asc" } } },
      },
    },
  });
  if (!assessment) throw new NotFoundError("Assessment not found.");

  const candidates = [];
  for (const c of assessment.candidates) {
    const attempts = [];
    for (const { id } of c.attempts) {
      const row = (await loadResultAttempt(db, id))!;
      const r = resultOf(row);
      // A terminated attempt is not a submission: it is never scored or counted as final.
      const terminated = row.status === AttemptStatus.TERMINATED;
      attempts.push({
        attemptId: row.id,
        attemptNumber: row.attemptNumber,
        status: row.status,
        submittedAt: row.submittedAt,
        terminatedAt: row.terminatedAt,
        evaluationStatus: row.evaluationStatus,
        maxMarks: r.maxMarks,
        obtained: terminated ? null : r.obtained,
        provisional: terminated ? null : r.provisional,
        percentage: terminated ? null : r.percentage,
        passed: terminated ? null : r.passed,
        final: !terminated && r.final,
        pendingAnswers: terminated ? 0 : r.counts.pending,
      });
    }
    // The candidate's result is their best final attempt.
    const best = attempts.filter((a) => a.final).sort((a, b) => (b.obtained ?? 0) - (a.obtained ?? 0))[0] ?? null;
    candidates.push({
      candidateId: c.id,
      learner: c.learner,
      examiner: c.examiner,
      resultStatus:
        attempts.length === 0
          ? "NOT_ATTEMPTED"
          : best
            ? "FINAL"
            : attempts.some((a) => a.status === AttemptStatus.IN_PROGRESS)
              ? "IN_PROGRESS"
              : attempts.some((a) => a.status === AttemptStatus.SUBMITTED || a.status === AttemptStatus.AUTO_SUBMITTED)
                ? "EVALUATION_PENDING"
                : "TERMINATED",
      best: best ? { attemptId: best.attemptId, obtained: best.obtained, percentage: best.percentage, passed: best.passed } : null,
      attempts,
    });
  }
  return {
    assessment: { id: assessment.id, name: assessment.name, status: assessment.status, resultVisibility: assessment.resultVisibility, publishedAt: assessment.publishedAt, batch: assessment.batch },
    candidates,
  };
}

/** Full breakdown of one attempt for admins: answers, scores, evaluators. */
export async function getAttemptResult(actor: SessionUser, attemptId: string) {
  assertAdmin(actor);
  const row = await loadResultAttempt(db, attemptId);
  if (!row) throw new NotFoundError("Attempt not found.");
  await auditResultView(actor, attemptId, row.assessmentId);
  return attemptBreakdown(row);
}

/** Question-by-question view with the answer key — for admins and the assigned examiner. */
export function attemptBreakdown(row: ResultAttemptRow) {
  const result = resultOf(row);
  const numbers = numbering(row);
  const responses = new Map(row.responses.map((r) => [r.assessmentQuestionId, r]));
  return {
    attempt: {
      id: row.id,
      attemptNumber: row.attemptNumber,
      status: row.status,
      startedAt: row.startedAt,
      submittedAt: row.submittedAt,
      timeTakenSeconds: timeTakenSeconds(row),
      evaluationStatus: row.evaluationStatus,
      evaluationFinalizedAt: row.evaluationFinalizedAt,
      evaluationFinalizedBy: row.evaluationFinalizedBy,
      terminatedAt: row.terminatedAt,
      terminationReason: row.terminationReason,
      terminatedBy: row.terminatedBy,
      focusViolations: row.focusViolations,
      lockedAt: row.lockedAt,
    },
    focusMonitoring: row.assessment.focusMonitoringEnabled ? { maxViolations: row.assessment.focusMaxViolations, action: row.assessment.focusViolationAction } : null,
    learner: row.learner,
    assessment: { id: row.assessment.id, name: row.assessment.name, status: row.assessment.status, batch: row.assessment.batch },
    result: { ...result, questions: undefined },
    questions: row.assessment.questions.map((aq, i) => {
      const snap = aq.snapshot as unknown as QuestionSnapshot;
      const r = responses.get(aq.id);
      const qr = result.questions[i];
      return {
        assessmentQuestionId: aq.id,
        number: numbers.get(aq.id)!,
        section: aq.paperQuestion?.section.title ?? null,
        context: aq.paperQuestion?.parent ? (aq.paperQuestion.parent.snapshot as { text: string; passage: string | null }) : null,
        type: snap.type,
        text: snap.text,
        options: snap.options,
        guidance: snap.guidance,
        kind: qr.kind,
        maxMarks: qr.maxMarks,
        awarded: qr.awarded,
        outcome: qr.outcome,
        status: answerStatus(qr),
        needsMarks: needsManualMarks(snap, r?.textAnswer ?? null, r?.attachments.length ?? 0),
        answer: { selectedOptionIds: r?.selectedOptionIds ?? [], textAnswer: r?.textAnswer ?? null, files: (r?.attachments ?? []).map((a) => a.file) },
        examinerComment: r?.examinerComment ?? null,
        evaluatedBy: r?.evaluatedBy ?? null,
        evaluatedAt: r?.evaluatedAt ?? null,
      };
    }),
  };
}

/**
 * Controlled correction: an admin reopens a finalized evaluation (with a reason) so the examiner
 * can change marks. Only before results are published — the assessment must not be RESULT_READY
 * (send it back to EVALUATION first), PUBLISHED or ARCHIVED.
 */
export async function reopenEvaluation(actor: SessionUser, attemptId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = reopenEvaluationSchema.safeParse(raw ?? {});
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  await db.$transaction(async (tx) => {
    const row = await tx.assessmentAttempt.findUnique({
      where: { id: attemptId },
      select: { evaluationStatus: true, assessment: { select: { status: true, publishedAt: true } }, responses: { select: { textAnswer: true, assessmentQuestion: { select: { snapshot: true } }, _count: { select: { attachments: true } } } } },
    });
    if (!row) throw new NotFoundError("Attempt not found.");
    const status = row.assessment.status;
    if (row.assessment.publishedAt || status === AssessmentStatus.PUBLISHED || status === AssessmentStatus.ARCHIVED) {
      throw new ConflictError("Results are already published; this evaluation can no longer be reopened.");
    }
    if (status === AssessmentStatus.RESULT_READY) throw new ConflictError("Move the assessment back to evaluation before reopening an attempt.");
    if (!row.responses.some((r) => needsManualMarks(r.assessmentQuestion.snapshot as unknown as QuestionSnapshot, r.textAnswer, r._count.attachments))) {
      throw new ConflictError("This attempt has no written answers to re-evaluate.");
    }
    const { count } = await tx.assessmentAttempt.updateMany({
      where: { id: attemptId, evaluationStatus: EvaluationStatus.COMPLETED },
      data: { evaluationStatus: EvaluationStatus.IN_PROGRESS, evaluationFinalizedAt: null, evaluationFinalizedById: null },
    });
    if (count === 0) throw new ConflictError("Only finalized evaluations can be reopened.");
    await recordAudit({ actorId: actor.id, action: AuditAction.EVALUATION_REOPENED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { reason: parsed.data.reason } }, tx);
  });
}

/**
 * Assessments that have reached the result stages, with attempt and evaluation counts (admin list).
 * Counts only — scores come from `listAssessmentResults`, which applies the result calculation.
 */
export async function listResultSummaries(actor: SessionUser, now: Date = new Date()) {
  assertAdmin(actor);
  await closeExpiredAttempts(now);
  const STAGES = [AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED, AssessmentStatus.ENDED, AssessmentStatus.EVALUATION, AssessmentStatus.RESULT_READY, AssessmentStatus.PUBLISHED, AssessmentStatus.ARCHIVED];
  const assessments = await db.assessment.findMany({
    where: { status: { in: STAGES } },
    orderBy: [{ endAt: "desc" }],
    select: {
      id: true,
      name: true,
      type: true,
      status: true,
      startAt: true,
      endAt: true,
      publishedAt: true,
      course: { select: { id: true, name: true } },
      batch: { select: { id: true, name: true } },
      _count: { select: { candidates: true } },
    },
  });
  const groups = await db.assessmentAttempt.groupBy({
    by: ["assessmentId", "status", "evaluationStatus"],
    where: { assessmentId: { in: assessments.map((a) => a.id) } },
    _count: { _all: true },
  });
  return assessments.map(({ _count, ...a }) => {
    const mine = groups.filter((g) => g.assessmentId === a.id);
    const count = (pred: (g: (typeof groups)[number]) => boolean) => mine.filter(pred).reduce((n, g) => n + g._count._all, 0);
    const submitted = (g: (typeof groups)[number]) => g.status === AttemptStatus.SUBMITTED || g.status === AttemptStatus.AUTO_SUBMITTED;
    return {
      ...a,
      candidates: _count.candidates,
      attempts: count(() => true),
      inProgress: count((g) => g.status === AttemptStatus.IN_PROGRESS),
      submitted: count(submitted),
      terminated: count((g) => g.status === AttemptStatus.TERMINATED),
      pendingEvaluation: count((g) => submitted(g) && g.evaluationStatus !== EvaluationStatus.COMPLETED),
      evaluationCompleted: count((g) => submitted(g) && g.evaluationStatus === EvaluationStatus.COMPLETED),
      published: !!a.publishedAt,
    };
  });
}
