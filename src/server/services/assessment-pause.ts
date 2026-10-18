import "server-only";
import { AssessmentStatus, AttemptStatus } from "@/generated/prisma/enums";
import { liveControlIssues, STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db } from "../db";
import { creditPause, syncTimeBasedStatuses } from "./assessments";
import { closeExpiredAttempts, effectiveDeadline } from "./attempts";

/*
 * Administrator pause / resume of a live assessment (ACTIVE ⇄ PAUSED).
 *
 * Pausing records when the pause began (assessment.pausedAt). While paused, learners can't answer,
 * upload or submit, and every running attempt's remaining time stands still (the attempt service
 * adds the time since pausedAt to deadlines). Resuming credits the pause to each attempt that sat
 * through it (deadline + pausedSeconds), so it costs the learner nothing — within the assessment's
 * window, which a pause never moves. Several pause/resume cycles add up; each is credited once.
 *
 * Both moves are single conditional updates on the assessment row (ACTIVE → PAUSED, PAUSED → ACTIVE
 * with the pausedAt that was read), so concurrent clicks can't both succeed or double-count a pause.
 */

async function load(id: string) {
  const a = await db.assessment.findUnique({ where: { id }, select: { id: true, name: true, status: true, endAt: true, pausedAt: true } });
  if (!a) throw new NotFoundError("Assessment not found.");
  return a;
}

function refuse(status: AssessmentStatus, action: "pause" | "resume"): never {
  if (action === "pause" && status === AssessmentStatus.PAUSED) throw new ConflictError("This assessment is already paused.");
  if (action === "resume" && status === AssessmentStatus.ACTIVE) throw new ConflictError("This assessment isn’t paused.");
  throw new ConflictError(`A ${STATUS_LABEL[status].toLowerCase()} assessment can’t be ${action === "pause" ? "paused" : "resumed"}. Only a live assessment can be paused, and only a paused one resumed.`);
}

/** ACTIVE → PAUSED. Running attempts stop progressing; nothing is lost. */
export async function pauseAssessment(actor: SessionUser, id: string, now: Date = new Date()) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);
  const a = await load(id);
  if (a.status !== AssessmentStatus.ACTIVE) refuse(a.status, "pause");
  const issues = liveControlIssues(a, now);
  if (issues.length) throw new ConflictError(issues.join(" "));
  // Attempts whose time ran out before the pause are closed first, so the pause can't revive them.
  await closeExpiredAttempts(now, id);

  return db.$transaction(async (tx) => {
    const { count } = await tx.assessment.updateMany({ where: { id, status: AssessmentStatus.ACTIVE, endAt: { gt: now } }, data: { status: AssessmentStatus.PAUSED, pausedAt: now } });
    if (count === 0) throw new ConflictError("The assessment changed in the meantime. Reload and try again.");
    const running = await tx.assessmentAttempt.count({ where: { assessmentId: id, status: AttemptStatus.IN_PROGRESS } });
    await recordAudit({ actorId: actor.id, action: AuditAction.ASSESSMENT_STATUS_CHANGED, entityType: "Assessment", entityId: id, metadata: { from: AssessmentStatus.ACTIVE, to: AssessmentStatus.PAUSED, trigger: "manual" } }, tx);
    await recordAudit({ actorId: actor.id, action: AuditAction.ASSESSMENT_PAUSED, entityType: "Assessment", entityId: id, metadata: { pausedAt: now.toISOString(), runningAttempts: running } }, tx);
    return { status: AssessmentStatus.PAUSED, pausedAt: now, runningAttempts: running };
  });
}

/** PAUSED → ACTIVE. Each attempt that sat through the pause gets that time back (within the window). */
export async function resumeAssessment(actor: SessionUser, id: string, now: Date = new Date()) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);
  const a = await load(id);
  if (a.status !== AssessmentStatus.PAUSED || !a.pausedAt) refuse(a.status, "resume");
  const pausedAt = a.pausedAt!;

  return db.$transaction(async (tx) => {
    const { count } = await tx.assessment.updateMany({
      where: { id, status: AssessmentStatus.PAUSED, pausedAt, endAt: { gt: now } },
      data: { status: AssessmentStatus.ACTIVE, pausedAt: null },
    });
    if (count === 0) throw new ConflictError("The assessment changed in the meantime. Reload and try again.");
    const credit = await creditPause(tx, id, pausedAt, now);
    await recordAudit({ actorId: actor.id, action: AuditAction.ASSESSMENT_STATUS_CHANGED, entityType: "Assessment", entityId: id, metadata: { from: AssessmentStatus.PAUSED, to: AssessmentStatus.ACTIVE, trigger: "manual" } }, tx);
    await recordAudit(
      { actorId: actor.id, action: AuditAction.ASSESSMENT_RESUMED, entityType: "Assessment", entityId: id, metadata: { pausedAt: pausedAt.toISOString(), resumedAt: now.toISOString(), pausedSeconds: credit.seconds, attemptsCredited: credit.attempts } },
      tx,
    );
    return { status: AssessmentStatus.ACTIVE, pausedSeconds: credit.seconds, attemptsCredited: credit.attempts };
  });
}

/**
 * What the live-control panel shows: status, when it started, the current pause, and the attempts in
 * progress right now (learner, start time, saved answers) — the ones an administrator can terminate.
 */
export async function getLiveControl(actor: SessionUser, id: string, now: Date = new Date()) {
  assertAdmin(actor);
  await syncTimeBasedStatuses(now, id);
  await closeExpiredAttempts(now, id);
  const a = await db.assessment.findUnique({
    where: { id },
    select: { status: true, startAt: true, endAt: true, pausedAt: true, timingMode: true, durationMinutes: true, proctoringEnabled: true, focusMonitoringEnabled: true, focusMaxViolations: true, focusViolationAction: true },
  });
  if (!a) throw new NotFoundError("Assessment not found.");
  const running = await db.assessmentAttempt.findMany({
    where: { assessmentId: id, status: AttemptStatus.IN_PROGRESS },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      attemptNumber: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      focusViolations: true,
      lockedAt: true,
      learner: { select: { name: true, email: true } },
      _count: { select: { responses: true } },
    },
  });
  return {
    status: a.status,
    startAt: a.startAt,
    endAt: a.endAt,
    pausedAt: a.pausedAt,
    runningAttempts: running.length,
    serverTime: now,
    focusMonitoring: a.proctoringEnabled && a.focusMonitoringEnabled ? { maxViolations: a.focusMaxViolations, action: a.focusViolationAction } : null,
    running: running.map(({ _count, deadlineAt, pausedSeconds, extensionSeconds, ...r }) => {
      // The same authoritative end time the learner's attempt runs on.
      const effectiveEndAt = effectiveDeadline({ startedAt: r.startedAt, deadlineAt, pausedSeconds, extensionSeconds }, a, now);
      return { ...r, savedAnswers: _count.responses, effectiveEndAt, remainingSeconds: Math.max(0, Math.floor((effectiveEndAt.getTime() - now.getTime()) / 1000)), extensionMinutes: extensionSeconds / 60 };
    }),
  };
}
