import "server-only";
import { emitMonitoringEvent, transaction } from "../realtime/publish";
import { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, AssessmentTimingMode, AttemptStatus, FocusViolationAction, ProctoringEventType, QuestionType, ResponseType, Role, UserStatus, type SectionAttemptRule } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { round2, sectionMaxMarks } from "@/lib/papers/rules";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { lockedByFrom, terminatedByFrom, type LockedBy, type TerminatedBy } from "@/lib/learner/staff-action";
import { ACTION_TAKEN, CLIPBOARD_EVENTS, effectiveProctoring, eventEnabled, eventSeverity, isViolation, learnerCameraConfig, learnerScreenConfig } from "@/lib/proctoring/config";
import { hasOptions } from "@/lib/questions/types";
import { saveResponsesSchema, submitAttemptSchema, type ResponseInput } from "@/lib/validation/attempt";
import { proctoringEventSchema } from "@/lib/validation/proctoring";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin, assertRole } from "../authz";
import { db, type DbTx } from "../db";
import { syncTimeBasedStatuses } from "./assessments";
import { setInitialEvaluationStatus } from "./evaluation-status";
import type { GroupSnapshot } from "./question-papers";

// ---------------------------------------------------------------------------
// Time: the server clock is the only source of truth
// ---------------------------------------------------------------------------

type TimingFields = { timingMode: AssessmentTimingMode; endAt: Date };

/**
 * Deadline for an attempt started at `startedAt`: start + duration + time spent in administrator
 * pauses (`pausedSeconds`), capped at the window end in WINDOW mode — a pause never moves the window.
 */
export function computeDeadline(startedAt: Date, assessment: TimingFields & { durationMinutes: number }, pausedSeconds = 0): Date {
  const full = new Date(startedAt.getTime() + (assessment.durationMinutes * 60 + pausedSeconds) * 1000);
  return assessment.timingMode === AssessmentTimingMode.WINDOW && assessment.endAt < full ? assessment.endAt : full;
}

/**
 * The deadline in force at `now` — the one authoritative end time of an attempt:
 *
 *   start + duration + administrator pauses (capped at the window end in WINDOW mode)
 *   + administrator time extensions (an explicit override: it may run past the window)
 *
 * In WINDOW mode it follows the assessment's *current* end time: ending the assessment early closes
 * running attempts, and extending the window gives capped attempts their time back — never more than
 * the duration. In FULL_DURATION mode it is the stored deadline, which pauses and extensions move.
 * While the assessment is paused (`pausedAt` set) the time since the pause began is added too, so the
 * remaining time stands still (in WINDOW mode up to the window end plus any extension).
 */
export function effectiveDeadline(
  attempt: { startedAt: Date; deadlineAt: Date; pausedSeconds?: number; extensionSeconds?: number },
  assessment: TimingFields & { durationMinutes: number; pausedAt?: Date | null },
  now: Date = new Date(),
): Date {
  const extension = (attempt.extensionSeconds ?? 0) * 1000;
  const window = assessment.timingMode === AssessmentTimingMode.WINDOW;
  // FULL_DURATION: the stored deadline already includes pauses and extensions.
  const base = window ? new Date(computeDeadline(attempt.startedAt, assessment, attempt.pausedSeconds ?? 0).getTime() + extension) : attempt.deadlineAt;
  if (!assessment.pausedAt || now <= assessment.pausedAt) return base;
  const frozen = new Date(base.getTime() + (now.getTime() - assessment.pausedAt.getTime()));
  const cap = new Date(assessment.endAt.getTime() + extension);
  return window && cap < frozen ? cap : frozen;
}

const remainingSeconds = (deadline: Date, now: Date) => Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/** A learner acting on one assessment (the route's — see forAssessment). Assignment is checked by each service. */
function assertExamSession(actor: SessionUser): asserts actor is SessionUser & { assessmentId: string } {
  assertRole(actor, Role.LEARNER);
  if (!actor.assessmentId) throw new ForbiddenError();
}

/** A learner acting on one of their own attempts (the attempt says which assessment). */
function assertLearner(actor: SessionUser) {
  assertRole(actor, Role.LEARNER);
}

const attemptTimingSelect = {
  id: true,
  assessmentId: true,
  learnerId: true,
  status: true,
  startedAt: true,
  deadlineAt: true,
  pausedSeconds: true,
  extensionSeconds: true,
  lockedAt: true,
  assessment: { select: { timingMode: true, endAt: true, durationMinutes: true, status: true, pausedAt: true } },
} satisfies Prisma.AssessmentAttemptSelect;

/** Refusal once proctoring (e.g. focus monitoring, fullscreen) has locked the attempt (the client recognises "locked"). */
export const LOCKED_MESSAGE = "Your exam has been locked. Your saved answers are kept; you can no longer change or submit them.";
/** The system's reason when focus monitoring terminates an attempt. */
export const FOCUS_TERMINATION_REASON = "Focus monitoring violation threshold exceeded";

/** A system termination by proctoring (focus monitoring or another control). */
const isProctoringTermination = (reason: string | null) => reason === FOCUS_TERMINATION_REASON || reason === PROCTORING_TERMINATION_REASON;

/**
 * Who locked a locked attempt, as the learner is told (lib/learner/staff-action.ts): the violation
 * limit records a proctoring event with the action LOCK; a manual lock is in the audit log with the
 * staff member who did it.
 */
async function lockedByOf(tx: DbTx, attemptId: string): Promise<LockedBy> {
  if (await tx.proctoringEvent.count({ where: { attemptId, actionTaken: "LOCK" } })) return lockedByFrom({ violationLock: true, staffRole: null });
  const manual = await tx.auditLog.findFirst({
    where: { entityType: "AssessmentAttempt", entityId: attemptId, action: AuditAction.ATTEMPT_LOCKED, actorId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { actor: { select: { role: true } } },
  });
  return lockedByFrom({ violationLock: false, staffRole: manual?.actor?.role });
}

/** Who terminated a terminated attempt, as the learner is told. */
const terminatedByOf = (row: { terminatedById: string | null; terminationReason: string | null; terminatedBy: { role: Role } | null }): TerminatedBy =>
  terminatedByFrom({ terminatedById: row.terminatedById, staffRole: row.terminatedBy?.role, proctoringReason: isProctoringTermination(row.terminationReason) });

/** Refusal while an administrator has paused the assessment (the client recognises "paused"). */
export const PAUSED_MESSAGE = "This assessment has been paused by the administrator. Your saved answers are kept; you can continue when it resumes.";

/** The assessment's proctoring controls and its one violation policy. */
const proctoringSettingsSelect = {
  proctoringEnabled: true,
  focusMonitoringEnabled: true,
  fullscreenEnabled: true,
  clipboardMonitoringEnabled: true,
  cameraRequired: true,
  faceDetectionEnabled: true,
  multipleFaceDetectionEnabled: true,
  faceMissingDetectionEnabled: true,
  cameraSnapshotsEnabled: true,
  screenMonitoringEnabled: true,
  focusMaxViolations: true,
  focusViolationAction: true,
} satisfies Prisma.AssessmentSelect;

/** Paused means the assessment is PAUSED right now (a pause can't outlive the window). */
const isPaused = (assessment: { status: AssessmentStatus; endAt: Date }, now: Date) => assessment.status === AssessmentStatus.PAUSED && now < assessment.endAt;

/**
 * The learner's own attempt. Any other id — another learner's attempt, a made-up one — is "not
 * found". Never narrowed by the request's assessment (see lib/learner/ownership.ts).
 */
async function findOwnAttempt(tx: DbTx, actor: SessionUser, attemptId: string) {
  const attempt = await tx.assessmentAttempt.findFirst({
    where: ownAttemptWhere(actor.id, attemptId),
    select: attemptTimingSelect,
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  return attempt;
}

/**
 * Lock the attempt row for the rest of the transaction if it is still in progress. Every write to
 * an attempt (autosave, submit, auto-submit) goes through this, so they can never interleave.
 */
async function lockInProgress(tx: DbTx, attemptId: string): Promise<boolean> {
  const { count } = await tx.assessmentAttempt.updateMany({ where: { id: attemptId, status: AttemptStatus.IN_PROGRESS }, data: { status: AttemptStatus.IN_PROGRESS } });
  return count === 1;
}

/** If the deadline has passed, close the attempt as AUTO_SUBMITTED (answers kept). Requires the row lock. */
async function autoSubmitIfDue(tx: DbTx, attempt: Prisma.AssessmentAttemptGetPayload<{ select: typeof attemptTimingSelect }>, now: Date) {
  const deadline = effectiveDeadline(attempt, attempt.assessment, now);
  if (now < deadline) return false;
  await tx.assessmentAttempt.update({ where: { id: attempt.id }, data: { status: AttemptStatus.AUTO_SUBMITTED, submittedAt: deadline } });
  await setInitialEvaluationStatus(tx, attempt.id, now);
  emitMonitoringEvent("ATTEMPT_AUTO_SUBMITTED", attempt.assessmentId, attempt.id, now);
  await recordAudit(
    { actorId: null, action: AuditAction.ATTEMPT_AUTO_SUBMITTED, entityType: "AssessmentAttempt", entityId: attempt.id, metadata: { assessmentId: attempt.assessmentId, deadline: deadline.toISOString() } },
    tx,
  );
  return true;
}

/**
 * Close every in-progress attempt whose deadline has passed. Correctness never depends on this
 * running (each request checks its own attempt), but it keeps listings accurate without a worker.
 */
export async function closeExpiredAttempts(now: Date = new Date(), assessmentId?: string) {
  const candidates = await db.assessmentAttempt.findMany({
    where: { status: AttemptStatus.IN_PROGRESS, ...(assessmentId ? { assessmentId } : {}) },
    select: attemptTimingSelect,
  });
  let closed = 0;
  for (const a of candidates.filter((x) => now >= effectiveDeadline(x, x.assessment, now))) {
    await transaction(async (tx) => {
      if (await lockInProgress(tx, a.id)) closed += Number(await autoSubmitIfDue(tx, a, now));
    });
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Learner view: exact assessment content, without answers
// ---------------------------------------------------------------------------

/** A supporting material as learners see it (metadata only; bytes via the file route). */
export interface ExamMaterial {
  fileId: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  description: string | null;
}

/** How a written question is answered (null for objective questions). */
export interface ExamResponseConfig {
  type: ResponseType;
  allowedFileTypes: string[];
  maxFileSizeMb: number;
  maxFiles: number;
  fileRequired: boolean;
}

export interface ExamQuestion {
  kind: "question";
  assessmentQuestionId: string;
  number: string;
  type: QuestionType;
  text: string;
  marks: number;
  /** Only when the assessment applies negative marking to objective questions. */
  negativeMarks: number;
  /** Option ids and text only — never which option is correct. */
  options: { id: string; text: string }[];
  response: ExamResponseConfig | null;
  materials: ExamMaterial[];
}

export interface ExamGroup {
  kind: "group";
  id: string;
  number: string;
  groupType: GroupSnapshot["groupType"];
  text: string;
  passage: string | null;
  materials: ExamMaterial[];
  children: ExamQuestion[];
}

export interface ExamSection {
  id: string;
  title: string;
  instructions: string | null;
  isRequired: boolean;
  attemptRule: string;
  attemptCount: number | null;
  items: (ExamQuestion | ExamGroup)[];
}

const materialsSelect = {
  orderBy: { position: "asc" },
  select: { description: true, file: { select: { id: true, fileName: true, extension: true, sizeBytes: true } } },
} satisfies Prisma.PaperQuestion$materialsArgs;

const toMaterials = (rows: { description: string | null; file: { id: string; fileName: string; extension: string; sizeBytes: number } }[]): ExamMaterial[] =>
  rows.map((m) => ({ fileId: m.file.id, fileName: m.file.fileName, extension: m.file.extension, sizeBytes: m.file.sizeBytes, description: m.description }));

async function loadExamContent(tx: DbTx, assessmentId: string) {
  const assessment = await tx.assessment.findUniqueOrThrow({
    where: { id: assessmentId },
    select: {
      id: true,
      name: true,
      instructions: true,
      durationMinutes: true,
      maxAttempts: true,
      timingMode: true,
      endAt: true,
      status: true,
      pausedAt: true,
      negativeMarking: true,
      allowResume: true,
      showQuestionPalette: true,
      allowMarkForReview: true,
      calculatorEnabled: true,
      calculatorType: true,
      spellCheckEnabled: true,
      proctoringEnabled: true,
      focusMonitoringEnabled: true,
      focusMaxViolations: true,
      focusViolationAction: true,
      fullscreenEnabled: true,
      clipboardMonitoringEnabled: true,
      cameraRequired: true,
      faceDetectionEnabled: true,
      faceMissingDetectionEnabled: true,
      cameraSnapshotsEnabled: true,
      screenMonitoringEnabled: true,
      multipleFaceDetectionEnabled: true,
      questions: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          marks: true,
          negativeMarks: true,
          snapshot: true,
          paperQuestion: {
            select: {
              parentId: true,
              responseType: true,
              allowedFileTypes: true,
              maxFileSizeMb: true,
              maxFiles: true,
              fileRequired: true,
              materials: materialsSelect,
              parent: { select: { id: true, groupType: true, snapshot: true, materials: materialsSelect } },
              section: { select: { id: true, title: true, instructions: true, isRequired: true, attemptRule: true, attemptCount: true } },
            },
          },
        },
      },
    },
  });

  const sections: ExamSection[] = [];
  let n = 0;
  for (const aq of assessment.questions) {
    const snap = aq.snapshot as unknown as QuestionSnapshot;
    const s = aq.paperQuestion?.section;
    const sectionId = s?.id ?? "questions";
    let section = sections.find((x) => x.id === sectionId);
    if (!section) {
      section = s
        ? { id: s.id, title: s.title, instructions: s.instructions, isRequired: s.isRequired, attemptRule: s.attemptRule, attemptCount: s.attemptCount, items: [] }
        : { id: sectionId, title: "Questions", instructions: null, isRequired: true, attemptRule: "ALL", attemptCount: null, items: [] };
      sections.push(section);
    }
    const objective = hasOptions(snap.type);
    const question = (number: string): ExamQuestion => ({
      kind: "question",
      assessmentQuestionId: aq.id,
      number,
      type: snap.type,
      text: snap.text,
      marks: aq.marks.toNumber(),
      negativeMarks: objective && assessment.negativeMarking ? aq.negativeMarks.toNumber() : 0,
      options: snap.options.map((o) => ({ id: o.id, text: o.text })),
      response:
        objective || !aq.paperQuestion
          ? objective
            ? null
            : { type: ResponseType.TEXT, allowedFileTypes: [], maxFileSizeMb: 0, maxFiles: 0, fileRequired: false }
          : {
              type: aq.paperQuestion.responseType,
              allowedFileTypes: aq.paperQuestion.allowedFileTypes,
              maxFileSizeMb: aq.paperQuestion.maxFileSizeMb,
              maxFiles: aq.paperQuestion.maxFiles,
              fileRequired: aq.paperQuestion.fileRequired,
            },
      materials: aq.paperQuestion ? toMaterials(aq.paperQuestion.materials) : [],
    });

    const parent = aq.paperQuestion?.parent;
    if (!parent) {
      section.items.push(question(String(++n)));
      continue;
    }
    let group = section.items.find((i): i is ExamGroup => i.kind === "group" && i.id === parent.id);
    if (!group) {
      const g = parent.snapshot as unknown as GroupSnapshot;
      group = { kind: "group", id: parent.id, number: String(++n), groupType: g.groupType, text: g.text, passage: g.passage, materials: toMaterials(parent.materials), children: [] };
      section.items.push(group);
    }
    group.children.push(question(`${group.number}(${String.fromCharCode(97 + group.children.length)})`));
  }
  return { assessment, sections };
}

async function buildView(tx: DbTx, attemptId: string, now: Date) {
  const attempt = await tx.assessmentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      id: true,
      assessmentId: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      lockedAt: true,
      focusViolations: true,
      lastActivityAt: true,
      submittedAt: true,
      responses: {
        select: {
          assessmentQuestionId: true,
          selectedOptionIds: true,
          textAnswer: true,
          markedForReview: true,
          clientSeq: true,
          updatedAt: true,
          attachments: { orderBy: { createdAt: "asc" }, select: { id: true, file: { select: { id: true, fileName: true, extension: true, sizeBytes: true } } } },
        },
      },
    },
  });
  const { assessment, sections } = await loadExamContent(tx, attempt.assessmentId);
  const deadline = effectiveDeadline(attempt, assessment, now);
  const open = attempt.status === AttemptStatus.IN_PROGRESS;
  return {
    attempt: {
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: deadline,
      submittedAt: attempt.submittedAt,
      /** Server time this view was produced at, so the client can align its countdown. */
      serverTime: now,
      remainingSeconds: open ? remainingSeconds(deadline, now) : 0,
      /** The administrator has paused the assessment: the countdown stands still, nothing can be changed. */
      paused: open && isPaused(assessment, now),
      /** The attempt is locked (violation limit, or a proctor / administrator): nothing can be changed or submitted. */
      locked: open && !!attempt.lockedAt,
      /** Who locked it, for the learner's message (null when not locked). */
      lockedBy: open && attempt.lockedAt ? await lockedByOf(tx, attempt.id) : null,
      focusViolations: attempt.focusViolations,
    },
    assessment: {
      id: assessment.id,
      name: assessment.name,
      instructions: assessment.instructions,
      durationMinutes: assessment.durationMinutes,
      maxAttempts: assessment.maxAttempts,
      showQuestionPalette: assessment.showQuestionPalette,
      allowMarkForReview: assessment.allowMarkForReview,
      /** The on-screen calculator offered during the exam, or null when it is off. */
      calculator: assessment.calculatorEnabled ? assessment.calculatorType : null,
      /** Browser-native spell check in written-answer fields (from the assessment's setting). */
      spellCheck: assessment.spellCheckEnabled,
      /** Focus monitoring (limit and action), or null when it (or proctoring, its master switch) is off. */
      focusMonitoring: assessment.proctoringEnabled && assessment.focusMonitoringEnabled ? { maxViolations: assessment.focusMaxViolations, action: assessment.focusViolationAction } : null,
      /** Fullscreen enforcement (proctoring on and fullscreen on): the exam must stay in fullscreen. */
      fullscreen: assessment.proctoringEnabled && assessment.fullscreenEnabled ? { maxViolations: assessment.focusMaxViolations, action: assessment.focusViolationAction } : null,
      /** Clipboard monitoring (proctoring on and clipboard on): copy / cut / paste are reported (never their contents). */
      clipboardMonitoring: assessment.proctoringEnabled && assessment.clipboardMonitoringEnabled ? { maxViolations: assessment.focusMaxViolations, action: assessment.focusViolationAction } : null,
      /** Camera required (proctoring on and camera on): the questions stay hidden until the camera check is passed. With face detection. */
      camera: learnerCameraConfig(assessment),
      /** Screen monitoring (phase 7): the learner shares their screen to start; periodic snapshots. */
      screen: learnerScreenConfig(assessment),
      allowResume: assessment.allowResume,
    },
    sections,
    responses: attempt.responses,
  };
}

export type AttemptView = Awaited<ReturnType<typeof buildView>>;

// ---------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Start the learner's attempt — or resume the one already in progress. All eligibility checks are
 * done here, server-side: active learner, assigned candidate, assessment open by the server clock,
 * a valid credential for this assessment, and attempts remaining. Concurrent calls are serialised
 * on the candidate row; the unique (candidate, attempt number) pair is the final guard.
 */
export async function startOrResumeAttempt(actor: SessionUser, now: Date = new Date()): Promise<AttemptView> {
  assertExamSession(actor);
  await syncTimeBasedStatuses(now, actor.assessmentId);
  try {
    return await startOnce(actor, now);
  } catch (err) {
    // Lost a race to create the same attempt number: the winner's attempt is now in progress.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return startOnce(actor, now);
    throw err;
  }
}

async function startOnce(actor: SessionUser & { assessmentId: string }, now: Date): Promise<AttemptView> {
  const outcome = await transaction(async (tx): Promise<Outcome<string>> => {
    const candidate = await tx.assessmentCandidate.findUnique({
      where: { assessmentId_learnerId: { assessmentId: actor.assessmentId, learnerId: actor.id } },
      select: { id: true },
    });
    if (!candidate) return { ok: false, error: "You are not assigned to this assessment." };
    // Serialise start/resume for this candidate.
    await tx.assessmentCandidate.updateMany({ where: { id: candidate.id }, data: { learnerId: actor.id } });

    const learner = await tx.user.findUnique({ where: { id: actor.id }, select: { status: true } });
    if (learner?.status !== UserStatus.ACTIVE) return { ok: false, error: "Your account has been disabled. Please contact an administrator." };

    const assessment = await tx.assessment.findUniqueOrThrow({
      where: { id: actor.assessmentId },
      select: { status: true, startAt: true, endAt: true, durationMinutes: true, timingMode: true, maxAttempts: true, allowResume: true },
    });

    const current = await tx.assessmentAttempt.findFirst({ where: { candidateId: candidate.id, status: AttemptStatus.IN_PROGRESS }, select: attemptTimingSelect });
    if (current) {
      await lockInProgress(tx, current.id);
      if (!(await autoSubmitIfDue(tx, current, now))) {
        const row = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: current.id }, select: { startedSessionId: true } });
        if (!assessment.allowResume && row.startedSessionId && row.startedSessionId !== actor.sessionId) {
          return { ok: false, error: "This assessment doesn’t allow resuming from a new sign-in. Please contact your administrator." };
        }
        await tx.assessmentAttempt.update({ where: { id: current.id }, data: { lastActivityAt: now } });
        return { ok: true, value: current.id };
      }
      // The running attempt just timed out; fall through — a new one may still be allowed.
    }

    if (isPaused(assessment, now)) return { ok: false, error: "This assessment is paused by the administrator. Please wait for it to resume." };
    if (assessment.status !== AssessmentStatus.ACTIVE || now < assessment.startAt || now >= assessment.endAt) {
      return { ok: false, error: "This assessment isn’t open right now." };
    }
    // The learner is authenticated by their session; being assigned (the candidate row above), the
    // assessment's window and the attempt limit decide whether they may start. A legacy exam-password
    // session is recorded on the attempt when it was issued for this candidate.
    const legacyCredentialId =
      actor.examCredentialId && (await tx.examCredential.count({ where: { id: actor.examCredentialId, candidateId: candidate.id } })) ? actor.examCredentialId : null;
    const used = await tx.assessmentAttempt.count({ where: { candidateId: candidate.id } });
    if (used >= assessment.maxAttempts) {
      return { ok: false, error: assessment.maxAttempts === 1 ? "You have already taken this assessment." : `You have used all ${assessment.maxAttempts} attempts.` };
    }

    const attempt = await tx.assessmentAttempt.create({
      data: {
        assessmentId: actor.assessmentId,
        learnerId: actor.id,
        candidateId: candidate.id,
        attemptNumber: used + 1,
        startedAt: now,
        deadlineAt: computeDeadline(now, assessment),
        lastActivityAt: now,
        startedSessionId: actor.sessionId ?? null,
        examCredentialId: legacyCredentialId,
      },
      select: { id: true, attemptNumber: true, deadlineAt: true },
    });
    emitMonitoringEvent("ATTEMPT_STARTED", actor.assessmentId, attempt.id, now);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ATTEMPT_STARTED,
        entityType: "AssessmentAttempt",
        entityId: attempt.id,
        metadata: { assessmentId: actor.assessmentId, attemptNumber: attempt.attemptNumber, deadlineAt: attempt.deadlineAt.toISOString() },
      },
      tx,
    );
    return { ok: true, value: attempt.id };
  });
  if (!outcome.ok) throw new ConflictError(outcome.error);
  return transaction((tx) => buildView(tx, outcome.value, now));
}

/**
 * The attempt's clock as the server sees it now — polled by the exam screen so a pause or resume
 * by the administrator reaches the learner without a reload. Closes the attempt if its time is up.
 */
export async function getMyAttemptClock(actor: SessionUser, attemptId: string, now: Date = new Date()) {
  assertLearner(actor);
  await findOwnAttempt(db, actor, attemptId);
  return transaction(async (tx) => {
    let attempt = await findOwnAttempt(tx, actor, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS && (await lockInProgress(tx, attemptId)) && (await autoSubmitIfDue(tx, attempt, now))) {
      attempt = await findOwnAttempt(tx, actor, attemptId);
    }
    const open = attempt.status === AttemptStatus.IN_PROGRESS;
    const ended =
      attempt.status === AttemptStatus.TERMINATED
        ? await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, select: { terminatedById: true, terminationReason: true, terminatedBy: { select: { role: true } } } })
        : null;
    const locked = open && !!attempt.lockedAt;
    return {
      status: attempt.status,
      paused: open && isPaused(attempt.assessment, now),
      locked,
      /** Who locked it (violation limit, proctor or administrator), for the learner's message. */
      lockedBy: locked ? await lockedByOf(tx, attemptId) : null,
      terminatedByFocus: !!ended && !ended.terminatedById && isProctoringTermination(ended.terminationReason),
      /** Who terminated it (violation limit, proctor or administrator), for the learner's message. */
      terminatedBy: ended ? terminatedByOf(ended) : null,
      remainingSeconds: open ? remainingSeconds(effectiveDeadline(attempt, attempt.assessment, now), now) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Focus monitoring
// ---------------------------------------------------------------------------

export type FocusOutcome = "IGNORED" | "WARNING" | "LOCKED" | "TERMINATED";
/** RECORDED: a non-violation (system) event was stored. */
export type ProctoringOutcome = FocusOutcome | "RECORDED";

/** The system's reason when another proctoring control terminates an attempt. */
export const PROCTORING_TERMINATION_REASON = "Proctoring violation threshold exceeded";

/**
 * Record a proctoring event for the learner's own running attempt — the one path for every
 * proctoring event, focus monitoring (C3) included. The browser only reports what happened (type,
 * an incident id, optionally a duration and a few small details); the server decides everything
 * else: the time, whether it counts, the violation number, the severity and any action.
 *
 * It is recorded only if proctoring and that control are on for the assessment (camera events only
 * when the camera is required), the attempt is the learner's, running and not locked, and the
 * assessment isn't paused; otherwise it is IGNORED and nothing is stored. The attempt row is locked
 * for the update, so concurrent reports count one at a time and never overshoot the limit
 * (violation numbers are also unique per attempt in the database); a repeated incident counts once.
 *
 * Violations share one counter (the attempt's focusViolations) and one policy (the assessment's
 * limit and action): at the limit the event's action is WARNING, LOCK (the existing lock) or
 * TERMINATE (the existing termination, with a system reason). Events are append-only and every
 * counted violation, lock and termination is audited (no browser details are stored in the audit).
 */
export async function recordProctoringEvent(actor: SessionUser, attemptId: string, raw: unknown, now: Date = new Date()) {
  assertLearner(actor);
  const parsed = proctoringEventSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Invalid proctoring event.");
  const input = parsed.data;
  // Clipboard monitoring records only that a copy / cut / paste happened: no details are accepted,
  // so clipboard contents can never reach the database or the audit log.
  if (CLIPBOARD_EVENTS.includes(input.eventType) && (input.metadata !== undefined || input.durationMs !== undefined)) {
    throw new ValidationError("Clipboard events carry no details.");
  }
  await findOwnAttempt(db, actor, attemptId);

  const outcome = await transaction(async (tx) => {
    if (!(await lockInProgress(tx, attemptId))) return { ok: false as const, error: await closedMessage(tx, attemptId) };
    const attempt = await findOwnAttempt(tx, actor, attemptId);
    if (await autoSubmitIfDue(tx, attempt, now)) return { ok: false as const, error: TIME_UP };
    const settings = await tx.assessment.findUniqueOrThrow({ where: { id: attempt.assessmentId }, select: proctoringSettingsSelect });
    const row = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attemptId }, select: { focusViolations: true, focusLastIncidentId: true, candidateId: true } });
    const state = (o: ProctoringOutcome, recorded: boolean, eventId: string | null = null) => ({
      ok: true as const,
      value: { recorded, outcome: o, violations: row.focusViolations, maxViolations: settings.focusMaxViolations, eventId },
    });

    if (!eventEnabled(input.eventType, effectiveProctoring(settings))) return state("IGNORED", false);
    const event = { attemptId, eventType: input.eventType, timestamp: now, durationMs: input.durationMs ?? null, ...(input.metadata ? { metadata: input.metadata } : {}) };

    if (!isViolation(input.eventType)) {
      const e = await tx.proctoringEvent.create({ data: { ...event, severity: eventSeverity(input.eventType, null) }, select: { id: true } });
      return state("RECORDED", true, e.id);
    }
    if (isPaused(attempt.assessment, now)) return state("IGNORED", false);
    if (attempt.lockedAt) return state("LOCKED", false);
    if (input.incidentId && row.focusLastIncidentId === input.incidentId) return state("WARNING", false);

    const violations = row.focusViolations + 1;
    const reached = violations >= settings.focusMaxViolations;
    const policy = reached ? settings.focusViolationAction : null;
    const actionTaken = policy ? ACTION_TAKEN[policy] : null;
    const focus = input.eventType === ProctoringEventType.FOCUS_LOST;
    const reason = focus ? FOCUS_TERMINATION_REASON : PROCTORING_TERMINATION_REASON;
    await tx.assessmentAttempt.update({
      where: { id: attemptId },
      data: {
        focusViolations: violations,
        focusLastIncidentId: input.incidentId ?? null,
        ...(policy === FocusViolationAction.LOCK ? { lockedAt: now } : {}),
        ...(policy === FocusViolationAction.TERMINATE ? { status: AttemptStatus.TERMINATED, terminatedAt: now, terminatedById: null, terminationReason: reason } : {}),
      },
    });
    const e = await tx.proctoringEvent.create({ data: { ...event, severity: eventSeverity(input.eventType, actionTaken), violationNumber: violations, actionTaken }, select: { id: true } });
    emitMonitoringEvent("PROCTORING_VIOLATION", attempt.assessmentId, attemptId, now);
    if (policy === FocusViolationAction.LOCK) emitMonitoringEvent("ATTEMPT_LOCKED", attempt.assessmentId, attemptId, now);
    if (policy === FocusViolationAction.TERMINATE) emitMonitoringEvent("ATTEMPT_TERMINATED", attempt.assessmentId, attemptId, now);

    const base = { assessmentId: attempt.assessmentId, candidateId: row.candidateId, learnerId: actor.id };
    const trigger = focus ? "focus_monitoring" : "proctoring";
    await recordAudit(
      {
        actorId: actor.id,
        action: focus ? AuditAction.ATTEMPT_FOCUS_VIOLATION : AuditAction.PROCTORING_VIOLATION,
        entityType: "AssessmentAttempt",
        entityId: attemptId,
        metadata: { ...base, eventType: input.eventType, eventId: e.id, violation: violations, maxViolations: settings.focusMaxViolations, actionTaken: actionTaken ?? "WARNING", at: now.toISOString() },
      },
      tx,
    );
    if (policy === FocusViolationAction.TERMINATE) {
      await recordAudit({ actorId: null, action: AuditAction.ATTEMPT_TERMINATED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { ...base, reason, terminatedAt: now.toISOString(), trigger, eventId: e.id } }, tx);
    }
    if (policy === FocusViolationAction.LOCK) {
      await recordAudit({ actorId: null, action: AuditAction.ATTEMPT_LOCKED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { ...base, reason, lockedAt: now.toISOString(), trigger, eventId: e.id } }, tx);
    }
    const o: FocusOutcome = policy === FocusViolationAction.TERMINATE ? "TERMINATED" : policy === FocusViolationAction.LOCK ? "LOCKED" : "WARNING";
    return { ok: true as const, value: { recorded: true, outcome: o as ProctoringOutcome, violations, maxViolations: settings.focusMaxViolations, eventId: e.id as string | null } };
  });
  if (!outcome.ok) throw new ConflictError(outcome.error);
  return outcome.value;
}

/**
 * Focus monitoring (C3): the learner left the exam (tab hidden / window lost focus). A focus-loss
 * proctoring event — same rules, same counter, same limit and action (see recordProctoringEvent).
 */
export async function recordFocusViolation(actor: SessionUser, attemptId: string, rawIncidentId: unknown, now: Date = new Date()) {
  assertLearner(actor);
  if (typeof rawIncidentId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(rawIncidentId)) throw new ValidationError("Invalid focus incident.");
  const { recorded, outcome, violations, maxViolations } = await recordProctoringEvent(actor, attemptId, { eventType: ProctoringEventType.FOCUS_LOST, incidentId: rawIncidentId }, now);
  return { recorded, outcome: outcome as FocusOutcome, violations, maxViolations };
}

/** Reload an attempt (resume after a refresh): content, saved answers and remaining time. */
export async function getMyAttempt(actor: SessionUser, attemptId: string, now: Date = new Date()): Promise<AttemptView> {
  assertLearner(actor);
  await findOwnAttempt(db, actor, attemptId);
  return transaction(async (tx) => {
    const attempt = await findOwnAttempt(tx, actor, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS && (await lockInProgress(tx, attemptId))) await autoSubmitIfDue(tx, attempt, now);
    return buildView(tx, attemptId, now);
  });
}

// ---------------------------------------------------------------------------
// Learner overview (instructions / dashboard): no question content
// ---------------------------------------------------------------------------

/**
 * One of the learner's assigned assessments (the request's) as seen before (or after) an attempt: details,
 * instructions, a section summary without any question content, and the learner's own attempts.
 * A running attempt whose deadline has passed is closed first, so the status shown is current.
 * `canStart` is a display hint only — starting re-checks everything (see startOrResumeAttempt).
 */
export async function getMyExamOverview(actor: SessionUser, now: Date = new Date()) {
  assertExamSession(actor);
  await syncTimeBasedStatuses(now, actor.assessmentId);
  // Only an assessment the learner is assigned to — and never a draft — exists for them.
  const candidate = await db.assessmentCandidate.findFirst({
    where: { assessmentId: actor.assessmentId, learnerId: actor.id, assessment: { status: { not: AssessmentStatus.DRAFT } } },
    select: { id: true },
  });
  if (!candidate) throw new NotFoundError("Assessment not found.");

  const running = await db.assessmentAttempt.findFirst({ where: { candidateId: candidate.id, status: AttemptStatus.IN_PROGRESS }, select: attemptTimingSelect });
  if (running) {
    await transaction(async (tx) => {
      if (await lockInProgress(tx, running.id)) await autoSubmitIfDue(tx, running, now);
    });
  }

  return transaction(async (tx) => {
    const { assessment, sections } = await loadExamContent(tx, actor.assessmentId);
    const details = await tx.assessment.findUniqueOrThrow({
      where: { id: actor.assessmentId },
      select: { description: true, status: true, startAt: true, endAt: true, course: { select: { name: true } } },
    });
    const attempts = await tx.assessmentAttempt.findMany({
      where: { candidateId: candidate.id },
      orderBy: { attemptNumber: "asc" },
      select: { id: true, attemptNumber: true, status: true, startedAt: true, submittedAt: true, terminatedById: true, terminationReason: true, terminatedBy: { select: { role: true } }, _count: { select: { responses: true } } },
    });
    const inProgress = attempts.find((a) => a.status === AttemptStatus.IN_PROGRESS) ?? null;
    const open = details.status === AssessmentStatus.ACTIVE && now >= details.startAt && now < details.endAt;
    const paused = isPaused(details, now);
    const attemptsLeft = Math.max(0, assessment.maxAttempts - attempts.length);
    const itemMarks = (i: ExamQuestion | ExamGroup) => (i.kind === "group" ? i.children.reduce((m, c) => m + c.marks, 0) : i.marks);

    return {
      assessment: {
        id: assessment.id,
        name: assessment.name,
        description: details.description,
        instructions: assessment.instructions,
        courseName: details.course.name,
        status: details.status,
        startAt: details.startAt,
        endAt: details.endAt,
        durationMinutes: assessment.durationMinutes,
        maxAttempts: assessment.maxAttempts,
        timingMode: assessment.timingMode,
        negativeMarking: assessment.negativeMarking,
        allowResume: assessment.allowResume,
        /** Fullscreen enforcement in force (with the violation policy): the learner enters fullscreen before the exam starts. */
        fullscreen: assessment.proctoringEnabled && assessment.fullscreenEnabled ? { maxViolations: assessment.focusMaxViolations, action: assessment.focusViolationAction } : null,
        /** Clipboard monitoring in force: the learner is told before starting. */
        clipboardMonitoring: assessment.proctoringEnabled && assessment.clipboardMonitoringEnabled,
        /** Camera required (with the violation policy): the learner passes a camera (and face) check before starting. */
        camera: learnerCameraConfig(assessment),
        /** Screen monitoring (phase 7): the learner shares their screen to start; periodic snapshots. */
        screen: learnerScreenConfig(assessment),
      },
      sections: sections.map((sec) => ({
        id: sec.id,
        title: sec.title,
        instructions: sec.instructions,
        isRequired: sec.isRequired,
        attemptRule: sec.attemptRule,
        attemptCount: sec.attemptCount,
        itemCount: sec.items.length,
        questionCount: sec.items.reduce((n, i) => n + (i.kind === "group" ? i.children.length : 1), 0),
        maxMarks: round2(sectionMaxMarks(sec.attemptRule as SectionAttemptRule, sec.attemptCount, sec.items.map(itemMarks))),
      })),
      attempts: attempts.map(({ _count, terminatedById, terminationReason, terminatedBy, ...a }) => ({
        ...a,
        savedResponses: _count.responses,
        /** Terminated by proctoring — focus monitoring or another control — not by staff. The reason text itself is never shown. */
        terminatedByFocus: a.status === AttemptStatus.TERMINATED && !terminatedById && isProctoringTermination(terminationReason),
        /** Who terminated it (violation limit, proctor or administrator), for the learner's message; null if not terminated. */
        terminatedBy: a.status === AttemptStatus.TERMINATED ? terminatedByOf({ terminatedById, terminationReason, terminatedBy }) : null,
      })),
      inProgressAttemptId: inProgress?.id ?? null,
      attemptsLeft,
      open,
      paused,
      /** Display hint: a new attempt could be started now (the start itself re-checks everything). */
      canStart: !inProgress && open && attemptsLeft > 0,
      serverTime: now,
    };
  });
}

// ---------------------------------------------------------------------------
// Autosave and submit
// ---------------------------------------------------------------------------

/** Check each answer against its question snapshot (option ids, single vs multiple, text vs options). */
async function validateAnswers(tx: DbTx, assessmentId: string, responses: ResponseInput[], allowMarkForReview: boolean) {
  const questions = await tx.assessmentQuestion.findMany({
    where: { assessmentId, id: { in: responses.map((r) => r.assessmentQuestionId) } },
    select: { id: true, snapshot: true },
  });
  const byId = new Map(questions.map((q) => [q.id, q.snapshot as unknown as QuestionSnapshot]));
  const errors: FieldErrors = {};
  const add = (i: number, field: string, message: string) => (errors[`responses.${i}.${field}`] ??= []).push(message);
  responses.forEach((r, i) => {
    const snap = byId.get(r.assessmentQuestionId);
    if (!snap) return add(i, "assessmentQuestionId", "This question is not part of the assessment");
    if (r.markedForReview && !allowMarkForReview) add(i, "markedForReview", "Mark for review is turned off for this assessment");
    if (hasOptions(snap.type)) {
      const ids = new Set(snap.options.map((o) => o.id));
      if (r.textAnswer) add(i, "textAnswer", "This question is answered by choosing an option");
      if (new Set(r.selectedOptionIds).size !== r.selectedOptionIds.length) add(i, "selectedOptionIds", "An option is selected twice");
      if (r.selectedOptionIds.some((id) => !ids.has(id))) add(i, "selectedOptionIds", "Unknown option");
      if (snap.type !== QuestionType.MCQ_MULTI && r.selectedOptionIds.length > 1) add(i, "selectedOptionIds", "Choose only one option");
    } else if (r.selectedOptionIds.length) {
      add(i, "selectedOptionIds", "This question is answered in writing");
    }
  });
  if (Object.keys(errors).length) throw new ValidationError("Some answers couldn’t be saved.", errors);
}

/** Upsert answers into a locked, in-progress attempt. Stale (lower clientSeq) saves are skipped. */
async function writeAnswers(tx: DbTx, attempt: { id: string; assessmentId: string }, responses: ResponseInput[]) {
  let saved = 0;
  let ignored = 0;
  for (const r of responses) {
    const existing = await tx.attemptResponse.findUnique({
      where: { attemptId_assessmentQuestionId: { attemptId: attempt.id, assessmentQuestionId: r.assessmentQuestionId } },
      select: { clientSeq: true },
    });
    if (existing && r.clientSeq !== undefined && r.clientSeq <= existing.clientSeq) {
      ignored++;
      continue;
    }
    const data = {
      selectedOptionIds: r.selectedOptionIds,
      textAnswer: r.textAnswer,
      markedForReview: r.markedForReview,
      clientSeq: r.clientSeq ?? existing?.clientSeq ?? 0,
    };
    await tx.attemptResponse.upsert({
      where: { attemptId_assessmentQuestionId: { attemptId: attempt.id, assessmentQuestionId: r.assessmentQuestionId } },
      create: { attemptId: attempt.id, assessmentId: attempt.assessmentId, assessmentQuestionId: r.assessmentQuestionId, ...data },
      update: data,
    });
    saved++;
  }
  return { saved, ignored };
}

const TIME_UP = "Time is up. Your saved answers were submitted automatically.";
const CLOSED = "This attempt has already been submitted. Answers can no longer be changed.";
/** Shown to a learner whose attempt an administrator terminated (never the administrator's reason). */
export const TERMINATED_MESSAGE = "Your assessment has been terminated. Your saved responses have been recorded. You can no longer continue this attempt.";

/** Why a write to a no-longer-running attempt is refused: terminated by an administrator, or submitted. */
async function closedMessage(tx: DbTx, attemptId: string) {
  const row = await tx.assessmentAttempt.findUnique({ where: { id: attemptId }, select: { status: true } });
  return row?.status === AttemptStatus.TERMINATED ? TERMINATED_MESSAGE : CLOSED;
}

/**
 * Autosave one or more answers. Idempotent (saving the same answer again changes nothing) and safe
 * to repeat or send out of order (see clientSeq). Refused once the attempt is submitted or past
 * its deadline — in the latter case the attempt is auto-submitted with what was already saved.
 */
export async function saveResponses(actor: SessionUser, attemptId: string, raw: unknown, now: Date = new Date()) {
  assertLearner(actor);
  const parsed = saveResponsesSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Some answers couldn’t be saved.");
  await findOwnAttempt(db, actor, attemptId);

  const outcome = await transaction(async (tx) => {
    if (!(await lockInProgress(tx, attemptId))) return { ok: false as const, error: await closedMessage(tx, attemptId) };
    const attempt = await findOwnAttempt(tx, actor, attemptId);
    if (await autoSubmitIfDue(tx, attempt, now)) return { ok: false as const, error: TIME_UP };
    if (isPaused(attempt.assessment, now)) return { ok: false as const, error: PAUSED_MESSAGE };
    if (attempt.lockedAt) return { ok: false as const, error: LOCKED_MESSAGE };
    const settings = await tx.assessment.findUniqueOrThrow({ where: { id: attempt.assessmentId }, select: { allowMarkForReview: true } });
    await validateAnswers(tx, attempt.assessmentId, parsed.data.responses, settings.allowMarkForReview);
    const result = await writeAnswers(tx, attempt, parsed.data.responses);
    await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { lastActivityAt: now } });
    const deadline = effectiveDeadline(attempt, attempt.assessment, now);
    return { ok: true as const, value: { ...result, deadlineAt: deadline, remainingSeconds: remainingSeconds(deadline, now), savedAt: now } };
  });
  if (!outcome.ok) throw new ConflictError(outcome.error);
  return outcome.value;
}

/**
 * Run a write against the learner's own attempt while it is still open — the same rules as
 * autosave: the row is locked, a submitted attempt is refused, and a passed deadline closes the
 * attempt (auto-submit) instead. Used for answer file uploads.
 */
export async function withOpenAttempt<T>(
  actor: SessionUser,
  attemptId: string,
  now: Date,
  fn: (tx: DbTx, attempt: { id: string; assessmentId: string; learnerId: string }) => Promise<T>,
): Promise<T> {
  assertLearner(actor);
  await findOwnAttempt(db, actor, attemptId);
  const outcome = await transaction(async (tx) => {
    if (!(await lockInProgress(tx, attemptId))) return { ok: false as const, error: await closedMessage(tx, attemptId) };
    const attempt = await findOwnAttempt(tx, actor, attemptId);
    if (await autoSubmitIfDue(tx, attempt, now)) return { ok: false as const, error: TIME_UP };
    if (isPaused(attempt.assessment, now)) return { ok: false as const, error: PAUSED_MESSAGE };
    if (attempt.lockedAt) return { ok: false as const, error: LOCKED_MESSAGE };
    const value = await fn(tx, attempt);
    await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { lastActivityAt: now } });
    return { ok: true as const, value };
  });
  if (!outcome.ok) throw new ConflictError(outcome.error);
  return outcome.value;
}

/**
 * Server-side check of the attempt's answer files before a manual submit, against each question's
 * configuration: every required file is there, and every uploaded file is one this question accepts
 * (type, size, count). Files are read through this attempt's own responses, so they necessarily
 * belong to this learner, attempt and question. Uploads already enforce the same rules; this is the
 * final guard. Returns the missing questions and the problems found (by question number).
 */
async function fileAnswerIssues(tx: DbTx, attempt: { id: string; assessmentId: string }) {
  const questions = await tx.assessmentQuestion.findMany({
    where: { assessmentId: attempt.assessmentId },
    select: {
      id: true,
      paperQuestion: { select: { responseType: true, allowedFileTypes: true, maxFileSizeMb: true, maxFiles: true, fileRequired: true } },
      responses: { where: { attemptId: attempt.id }, select: { attachments: { select: { file: { select: { fileName: true, extension: true, sizeBytes: true } } } } } },
    },
  });
  const missing = new Set<string>();
  const invalid = new Map<string, string[]>();
  for (const q of questions) {
    const files = q.responses[0]?.attachments.map((a) => a.file) ?? [];
    const pq = q.paperQuestion;
    const acceptsFiles = !!pq && pq.responseType !== ResponseType.TEXT;
    if (acceptsFiles && pq.fileRequired && files.length === 0) missing.add(q.id);
    const problems: string[] = [];
    if (!acceptsFiles && files.length) problems.push("this question doesn’t take files");
    if (acceptsFiles) {
      if (files.length > pq.maxFiles) problems.push(`at most ${pq.maxFiles} file${pq.maxFiles === 1 ? "" : "s"}`);
      for (const f of files) {
        if (!pq.allowedFileTypes.includes(f.extension)) problems.push(`${f.fileName} isn’t an accepted type`);
        if (f.sizeBytes > pq.maxFileSizeMb * 1024 * 1024) problems.push(`${f.fileName} is larger than ${pq.maxFileSizeMb} MB`);
      }
    }
    if (problems.length) invalid.set(q.id, problems);
  }
  if (missing.size === 0 && invalid.size === 0) return null;
  const { sections } = await loadExamContent(tx, attempt.assessmentId);
  const numberOf = new Map(sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "group" ? i.children : [i]))).map((q) => [q.assessmentQuestionId, `Q${q.number}`]));
  const label = (id: string) => numberOf.get(id) ?? "a question";
  return {
    missing: [...missing].map(label),
    invalid: [...invalid].map(([id, problems]) => `${label(id)}: ${problems.join("; ")}`),
  };
}

/**
 * Submit: save any final answers and close the attempt, all in one transaction (nothing is half
 * submitted). Submitting again returns the same result. After the deadline the attempt is closed
 * as AUTO_SUBMITTED with the answers saved before the deadline; late answers are not stored.
 */
export async function submitAttempt(actor: SessionUser, attemptId: string, raw: unknown = {}, now: Date = new Date()) {
  assertLearner(actor);
  const parsed = submitAttemptSchema.safeParse(raw ?? {});
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Some answers couldn’t be saved.");
  await findOwnAttempt(db, actor, attemptId);

  const result = await transaction(async (tx) => {
    const attempt = await findOwnAttempt(tx, actor, attemptId);
    if (!(await lockInProgress(tx, attemptId))) {
      // A terminated attempt is never reported as submitted.
      if ((await closedMessage(tx, attemptId)) === TERMINATED_MESSAGE) throw new ConflictError(TERMINATED_MESSAGE);
      return { alreadySubmitted: true, lateAnswersIgnored: false };
    }
    if (await autoSubmitIfDue(tx, attempt, now)) return { alreadySubmitted: false, lateAnswersIgnored: parsed.data.responses.length > 0 };
    if (isPaused(attempt.assessment, now)) throw new ConflictError(PAUSED_MESSAGE);
    if (attempt.lockedAt) throw new ConflictError(LOCKED_MESSAGE);
    if (parsed.data.responses.length) {
      const settings = await tx.assessment.findUniqueOrThrow({ where: { id: attempt.assessmentId }, select: { allowMarkForReview: true } });
      await validateAnswers(tx, attempt.assessmentId, parsed.data.responses, settings.allowMarkForReview);
      await writeAnswers(tx, attempt, parsed.data.responses);
    }
    // A learner submitting by hand must have uploaded every required file, and only files the
    // questions accept (auto-submit at the deadline doesn't wait).
    const issues = await fileAnswerIssues(tx, attempt);
    if (issues?.missing.length) {
      throw new ValidationError(`Upload the required file for ${issues.missing.join(", ")} before submitting.`, {
        files: [...issues.missing.map((m) => `${m}: required file missing`), ...issues.invalid],
      });
    }
    if (issues?.invalid.length) {
      throw new ValidationError(`Some uploaded files don’t meet the question’s rules — ${issues.invalid.join(" · ")}. Replace or remove them before submitting.`, { files: issues.invalid });
    }
    await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { status: AttemptStatus.SUBMITTED, submittedAt: now, lastActivityAt: now } });
    await setInitialEvaluationStatus(tx, attemptId, now);
    emitMonitoringEvent("ATTEMPT_SUBMITTED", attempt.assessmentId, attemptId, now);
    await recordAudit(
      { actorId: actor.id, action: AuditAction.ATTEMPT_SUBMITTED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { assessmentId: attempt.assessmentId } },
      tx,
    );
    return { alreadySubmitted: false, lateAnswersIgnored: false };
  });

  const final = await db.assessmentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { id: true, status: true, submittedAt: true, _count: { select: { responses: true } } },
  });
  return { id: final.id, status: final.status, submittedAt: final.submittedAt, savedResponses: final._count.responses, ...result };
}

// ---------------------------------------------------------------------------
// Admin inspection
// ---------------------------------------------------------------------------

/** Every attempt of an assessment (admin). Expired attempts are closed first so statuses are current. */
export async function listAttempts(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  assertAdmin(actor);
  await closeExpiredAttempts(now, assessmentId);
  const rows = await db.assessmentAttempt.findMany({
    where: { assessmentId },
    orderBy: [{ startedAt: "asc" }],
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      lastActivityAt: true,
      submittedAt: true,
      learner: { select: { id: true, name: true, email: true } },
      _count: { select: { responses: true } },
    },
  });
  return rows.map(({ _count, ...r }) => ({ ...r, responseCount: _count.responses }));
}

/** One attempt with its saved responses (admin). Read-only: nothing here changes an attempt. */
export async function getAttemptForAdmin(actor: SessionUser, attemptId: string) {
  assertAdmin(actor);
  const attempt = await db.assessmentAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      assessmentId: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      submittedAt: true,
      learner: { select: { id: true, name: true, email: true } },
      responses: {
        orderBy: { assessmentQuestion: { position: "asc" } },
        select: { assessmentQuestionId: true, selectedOptionIds: true, textAnswer: true, markedForReview: true, updatedAt: true },
      },
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  return attempt;
}
