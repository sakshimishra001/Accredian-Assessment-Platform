import "server-only";
import { emitMonitoringEvent, transaction } from "../realtime/publish";
import { AttemptStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { db } from "../db";
import { parseActionReason, STATUS_WORD } from "./attempt-termination";
import { closeExpiredAttempts } from "./attempts";
import { assertCanProctor } from "./proctor-assignments";

/*
 * Manual lock of one learner's running attempt, by an administrator or a proctor assigned to its
 * assessment (proctor dashboard, phase 3). It sets the same `lockedAt` the proctoring violation limit
 * sets, so the learner's exam reacts exactly as it already does to a lock (on its next clock poll, or
 * its next save): nothing can be changed or submitted any more, saved answers are kept, and the attempt
 * closes at its deadline. The automatic, violation-based lock is untouched.
 *
 * Checked on the server, in order: the actor may proctor the assessment (admin, or an assigned
 * proctor — anyone else is refused, an unassigned proctor gets "not found"); the attempt belongs to
 * that assessment ("not found" otherwise); it is still running and not locked. The lock is one
 * conditional update, so two staff locking at once — or a lock racing the learner's submit or the
 * deadline — leave exactly one outcome. A reason is required; it is kept in the audit log, with the
 * actor (the learner never sees it).
 */
export async function lockAttempt(actor: SessionUser, input: { assessmentId: string; attemptId: string; reason: unknown }, now: Date = new Date()) {
  await assertCanProctor(actor, input.assessmentId);
  const reason = parseActionReason(input.reason, "locking");
  const where = { id: input.attemptId, assessmentId: input.assessmentId };
  const attempt = await db.assessmentAttempt.findFirst({ where, select: { id: true, candidateId: true, learnerId: true, status: true, lockedAt: true, learner: { select: { name: true } } } });
  if (!attempt) throw new NotFoundError("Attempt not found in this assessment.");
  // An attempt whose time is already up is closed (auto-submitted) first; the lock never overrides that.
  await closeExpiredAttempts(now, input.assessmentId);

  return transaction(async (tx) => {
    const { count } = await tx.assessmentAttempt.updateMany({ where: { ...where, status: AttemptStatus.IN_PROGRESS, lockedAt: null }, data: { lockedAt: now } });
    if (count === 0) {
      const current = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true, lockedAt: true } });
      if (current.status !== AttemptStatus.IN_PROGRESS) throw new ConflictError(`This attempt ${STATUS_WORD[current.status] ?? "isn’t in progress"}.`);
      throw new ConflictError("This attempt is already locked.");
    }
    emitMonitoringEvent("ATTEMPT_LOCKED", input.assessmentId, attempt.id, now);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ATTEMPT_LOCKED,
        entityType: "AssessmentAttempt",
        entityId: attempt.id,
        metadata: { assessmentId: input.assessmentId, candidateId: attempt.candidateId, learnerId: attempt.learnerId, reason, lockedAt: now.toISOString(), trigger: "manual", actorRole: actor.role },
      },
      tx,
    );
    return { attemptId: attempt.id, learnerName: attempt.learner.name, lockedAt: now };
  });
}
