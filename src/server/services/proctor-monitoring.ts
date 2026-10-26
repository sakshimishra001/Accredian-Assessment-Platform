import "server-only";
import { AssessmentStatus, AttemptStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import { effectiveProctoring, type ProctoringSettings } from "@/lib/proctoring/config";
import { EMPTY_VIOLATIONS, summarizeEvents, summarizeViolations, type ViolationSummary } from "@/lib/proctoring/violation-summary";
import { AuditAction } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { loadLiveAttempts } from "./assessment-pause";
import { syncTimeBasedStatuses } from "./assessments";
import { closeExpiredAttempts, effectiveDeadline } from "./attempts";
import { presenceOf } from "./presence";
import { evidenceCountsByAttempt, listAttemptEvidence } from "./proctoring-evidence";
import { listAttemptProctoringEvents } from "./proctoring";
import { assertCanProctor } from "./proctor-assignments";

/*
 * Proctor dashboard, phase 2: read-only monitoring. Every function authorizes on the server first:
 * an administrator sees any assessment; a proctor (REVIEWER) only the assessments they are assigned
 * to (assertCanProctor — anything else is "not found"); examiners and learners are refused. Data is
 * read fresh on every request (the pages poll); nothing here changes an attempt except closing ones
 * whose time is up, exactly as every other read of live attempts does.
 */

/** Assessments a proctor can be monitoring: published ones that aren't archived. */
const MONITORED: readonly AssessmentStatus[] = [
  AssessmentStatus.SCHEDULED,
  AssessmentStatus.ACTIVE,
  AssessmentStatus.PAUSED,
  AssessmentStatus.ENDED,
  AssessmentStatus.EVALUATION,
  AssessmentStatus.RESULT_READY,
  AssessmentStatus.PUBLISHED,
];
/** Live first, then upcoming, then finished. */
const ORDER: Partial<Record<AssessmentStatus, number>> = { ACTIVE: 0, PAUSED: 0, SCHEDULED: 1 };

/** The assessments the actor may proctor: all (admin) or those assigned to them (proctor). */
export async function listProctorAssessments(actor: SessionUser, now: Date = new Date()) {
  assertRole(actor, Role.ADMIN, Role.REVIEWER);
  const where = {
    status: { in: [...MONITORED] },
    ...(actor.role === Role.REVIEWER ? { proctors: { some: { proctorId: actor.id, proctor: { status: UserStatus.ACTIVE } } } } : {}),
  };
  // Bring time-based statuses and running attempts up to date first, as every live view does.
  for (const { id } of await db.assessment.findMany({ where, select: { id: true } })) {
    await syncTimeBasedStatuses(now, id);
    await closeExpiredAttempts(now, id);
  }
  const rows = await db.assessment.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      startAt: true,
      endAt: true,
      durationMinutes: true,
      timingMode: true,
      proctoringEnabled: true,
      batch: { select: { name: true } },
      _count: { select: { candidates: true, attempts: { where: { status: AttemptStatus.IN_PROGRESS } } } },
    },
  });
  return rows
    .map(({ _count, batch, ...a }) => ({ ...a, batchName: batch?.name ?? null, assignedLearners: _count.candidates, activeAttempts: _count.attempts }))
    .sort((x, y) => (ORDER[x.status] ?? 2) - (ORDER[y.status] ?? 2) || (x.status === AssessmentStatus.SCHEDULED ? +x.startAt - +y.startAt : +y.startAt - +x.startAt));
}

/**
 * Who may receive an assessment's live monitoring events: exactly who may monitor it (an
 * administrator, or an active proctor assigned to it — assertCanProctor), and only for a published
 * assessment that isn't archived. Returns the assessment's id as stored — the stream subscribes to
 * that, never to anything taken from the browser unchecked.
 */
export async function authorizeMonitoringStream(actor: SessionUser, assessmentId: string) {
  await assertCanProctor(actor, assessmentId);
  const a = await db.assessment.findUnique({ where: { id: assessmentId }, select: { id: true, status: true } });
  if (!a || !MONITORED.includes(a.status)) throw new NotFoundError("Assessment not found.");
  return a.id;
}

/** What the dashboard shows status for (phase 7): the camera, face detection and screen sharing, as in force. */
export function monitoringOf(s: ProctoringSettings) {
  const p = effectiveProctoring(s);
  return { camera: p.camera, face: p.faceDetection, screen: p.screen, evidence: p.cameraSnapshots || p.screen };
}

/** Counted violations per attempt, by kind (grouped from the event log). */
async function violationsByAttempt(attemptIds: string[]) {
  if (attemptIds.length === 0) return new Map<string, ViolationSummary>();
  const groups = await db.proctoringEvent.groupBy({
    by: ["attemptId", "eventType"],
    where: { attemptId: { in: attemptIds }, violationNumber: { not: null } },
    _count: { _all: true },
  });
  const byAttempt = new Map<string, { eventType: (typeof groups)[number]["eventType"]; count: number }[]>();
  for (const g of groups) byAttempt.set(g.attemptId, [...(byAttempt.get(g.attemptId) ?? []), { eventType: g.eventType, count: g._count._all }]);
  return new Map([...byAttempt].map(([id, rows]) => [id, summarizeViolations(rows)]));
}

/** One assessment's live monitoring view: its running attempts with timing and violations by kind. */
export async function getProctorMonitoring(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  await assertCanProctor(actor, assessmentId);
  const { assessment: a, running } = await loadLiveAttempts(assessmentId, now);
  const [violations, assignedLearners, evidence] = await Promise.all([
    violationsByAttempt(running.map((r) => r.id)),
    db.assessmentCandidate.count({ where: { assessmentId } }),
    evidenceCountsByAttempt(assessmentId, running.map((r) => r.id)),
  ]);
  return {
    assessment: {
      id: a.id,
      name: a.name,
      status: a.status,
      startAt: a.startAt,
      endAt: a.endAt,
      pausedAt: a.pausedAt,
      timingMode: a.timingMode,
      durationMinutes: a.durationMinutes,
      assignedLearners,
      /** What is monitored (phase 7): camera, face detection, screen. */
      monitoring: monitoringOf(a),
      proctoring: {
        proctoringEnabled: a.proctoringEnabled,
        focusMonitoringEnabled: a.focusMonitoringEnabled,
        fullscreenEnabled: a.fullscreenEnabled,
        clipboardMonitoringEnabled: a.clipboardMonitoringEnabled,
        cameraRequired: a.cameraRequired,
        faceDetectionEnabled: a.faceDetectionEnabled,
        multipleFaceDetectionEnabled: a.multipleFaceDetectionEnabled,
        faceMissingDetectionEnabled: a.faceMissingDetectionEnabled,
        cameraSnapshotsEnabled: a.cameraSnapshotsEnabled,
        screenMonitoringEnabled: a.screenMonitoringEnabled,
        focusMaxViolations: a.focusMaxViolations,
        focusViolationAction: a.focusViolationAction,
      },
    },
    serverTime: now,
    attempts: running.map((r) => ({
      id: r.id,
      attemptNumber: r.attemptNumber,
      status: r.status,
      learner: { name: r.learner.name, email: r.learner.email },
      startedAt: r.startedAt,
      effectiveEndAt: r.effectiveEndAt,
      remainingSeconds: r.remainingSeconds,
      lockedAt: r.lockedAt,
      lastActivityAt: r.lastActivityAt,
      savedAnswers: r.savedAnswers,
      /** The server's shared counter (it drives the WARN / LOCK / TERMINATE action). */
      counted: r.focusViolations,
      violations: violations.get(r.id) ?? EMPTY_VIOLATIONS,
      /** Connected now (exam page heartbeats; phase 6) — connection status, not a violation. Includes camera / face / screen state (phase 7). */
      presence: presenceOf(r.id, true),
      /** Proctoring evidence snapshots stored for the attempt (phase 7). */
      evidenceCount: evidence.get(r.id) ?? 0,
    })),
  };
}

/**
 * One attempt of an assessment the actor may proctor: the learner, timing, lock state, violations by
 * kind and the full event timeline. An attempt of another assessment is "not found" — the URL's
 * assessment and the attempt must match.
 */
export async function getProctorAttempt(actor: SessionUser, assessmentId: string, attemptId: string, now: Date = new Date()) {
  await assertCanProctor(actor, assessmentId);
  await closeExpiredAttempts(now, assessmentId);
  const attempt = await db.assessmentAttempt.findFirst({
    where: { id: attemptId, assessmentId },
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      submittedAt: true,
      lockedAt: true,
      lastActivityAt: true,
      terminatedAt: true,
      terminatedById: true,
      terminatedBy: { select: { name: true, role: true } },
      terminationReason: true,
      focusViolations: true,
      learner: { select: { name: true, email: true } },
      assessment: {
        select: {
          id: true,
          name: true,
          status: true,
          timingMode: true,
          endAt: true,
          durationMinutes: true,
          pausedAt: true,
          focusMaxViolations: true,
          focusViolationAction: true,
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
        },
      },
      _count: { select: { responses: true } },
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  const [events, manualActions, evidence] = await Promise.all([listAttemptProctoringEvents(actor, attempt.id), listManualActions(attempt.id), listAttemptEvidence(actor, assessmentId, attempt.id)]);
  const { assessment, _count, deadlineAt, pausedSeconds, extensionSeconds, terminatedById, terminatedBy, ...a } = attempt;
  const running = a.status === AttemptStatus.IN_PROGRESS;
  const effectiveEndAt = effectiveDeadline({ startedAt: a.startedAt, deadlineAt, pausedSeconds, extensionSeconds }, assessment, now);
  return {
    assessment: {
      id: assessment.id,
      name: assessment.name,
      status: assessment.status,
      maxViolations: assessment.focusMaxViolations,
      action: assessment.focusViolationAction,
      /** What is monitored (phase 7): camera, face detection, screen. */
      monitoring: monitoringOf(assessment),
    },
    attempt: {
      ...a,
      effectiveEndAt,
      remainingSeconds: running ? Math.max(0, Math.floor((effectiveEndAt.getTime() - now.getTime()) / 1000)) : 0,
      savedAnswers: _count.responses,
      /** Terminated automatically by the proctoring limit (no person), rather than by an administrator. */
      terminatedBySystem: a.status === AttemptStatus.TERMINATED && !terminatedById,
      /** Who terminated it (an administrator or a proctor), when a person did. */
      terminatedBy: terminatedBy ? { name: terminatedBy.name, role: terminatedBy.role === Role.ADMIN ? "Administrator" : "Proctor" } : null,
    },
    violations: summarizeEvents(events),
    /** Connected now (exam page heartbeats; phase 6); an attempt that has ended is never "online". */
    presence: presenceOf(attempt.id, running),
    /** Proctoring evidence snapshots, oldest first (metadata only; images via the authorized evidence route). */
    evidence,
    events,
    manualActions,
    serverTime: now,
  };
}

/**
 * The context of one attempt for pages about it (the evidence viewer): assessment name, learner name
 * and attempt number. Same authorization as getProctorAttempt: the assessment must be one the actor
 * may proctor and the attempt must belong to it — otherwise "not found".
 */
export async function getProctorAttemptContext(actor: SessionUser, assessmentId: string, attemptId: string) {
  await assertCanProctor(actor, assessmentId);
  const attempt = await db.assessmentAttempt.findFirst({
    where: { id: attemptId, assessmentId },
    select: { id: true, attemptNumber: true, learner: { select: { name: true } }, assessment: { select: { id: true, name: true } } },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  return { attemptId: attempt.id, attemptNumber: attempt.attemptNumber, learner: { name: attempt.learner.name }, assessment: attempt.assessment };
}

/** A staff member's role as the dashboard shows it. */
const STAFF_ROLE: Partial<Record<Role, string>> = { ADMIN: "Administrator", REVIEWER: "Proctor" };

/**
 * Manual lock / terminate actions on one attempt, from the audit log: only those two actions, only
 * for this attempt, and only those done by a person (the violation limit's own lock / termination
 * have no actor and already appear as proctoring events). Callers authorize first — here, after
 * assertCanProctor and the attempt-belongs-to-assessment check in getProctorAttempt.
 */
async function listManualActions(attemptId: string) {
  const rows = await db.auditLog.findMany({
    where: { entityType: "AssessmentAttempt", entityId: attemptId, action: { in: [AuditAction.ATTEMPT_LOCKED, AuditAction.ATTEMPT_TERMINATED] }, actorId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, action: true, createdAt: true, metadata: true, actor: { select: { name: true, role: true } } },
  });
  return rows.map((r) => {
    const reason = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) && typeof (r.metadata as Record<string, unknown>).reason === "string" ? ((r.metadata as Record<string, unknown>).reason as string) : null;
    return {
      id: r.id,
      at: r.createdAt,
      kind: r.action === AuditAction.ATTEMPT_LOCKED ? ("lock" as const) : ("terminate" as const),
      actor: r.actor ? { name: r.actor.name, role: STAFF_ROLE[r.actor.role] ?? "Staff" } : null,
      reason,
    };
  });
}

export type ManualAction = Awaited<ReturnType<typeof listManualActions>>[number];
