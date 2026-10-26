import "server-only";
import { AssessmentStatus, AttemptStatus, Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import type { SessionUser } from "../auth/session";
import { assertRole } from "../authz";
import { db } from "../db";
import { effectiveDeadline } from "./attempts";

/*
 * "The learner's own attempt, running now" — for what the exam page sends besides answers and
 * proctoring events: the presence heartbeat (phase 6) and evidence snapshots (phase 7). Read-only:
 * it never closes an expired attempt, locks a row or touches timing, so it can't hold up autosave.
 */

/** Assessments in which an attempt can be running. */
const LIVE: readonly AssessmentStatus[] = [AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED];

/**
 * The learner's own attempt with its assessment's proctoring settings, if it is running: in
 * progress, not locked, before its deadline, in a live assessment. Another learner's (or an unknown)
 * attempt is "not found"; one that isn't running is a conflict. Staff are refused.
 */
export async function findOwnRunningAttempt(actor: SessionUser, attemptId: string, now: Date = new Date()) {
  assertRole(actor, Role.LEARNER);
  const attempt = await db.assessmentAttempt.findFirst({
    where: ownAttemptWhere(actor.id, attemptId),
    select: {
      id: true,
      assessmentId: true,
      learnerId: true,
      status: true,
      lockedAt: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      assessment: {
        select: {
          status: true,
          timingMode: true,
          endAt: true,
          durationMinutes: true,
          pausedAt: true,
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
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found.");
  const running =
    attempt.status === AttemptStatus.IN_PROGRESS && !attempt.lockedAt && LIVE.includes(attempt.assessment.status) && now < effectiveDeadline(attempt, attempt.assessment, now);
  if (!running) throw new ConflictError("This attempt is not running.");
  return attempt;
}
