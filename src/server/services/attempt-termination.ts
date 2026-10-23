import "server-only";
import { emitMonitoringEvent, transaction } from "../realtime/publish";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AttemptStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db } from "../db";
import { closeExpiredAttempts } from "./attempts";
import { assertCanProctor } from "./proctor-assignments";

/*
 * Termination of exam attempts by staff: IN_PROGRESS → TERMINATED. One attempt: an administrator or a
 * proctor assigned to its assessment (assertCanProctor); all running attempts at once: administrators only.
 * Not a submission — a terminated attempt is never evaluated, scored or reported as submitted. Saved
 * answers, uploaded files, timestamps and the attempt itself are kept; no new attempt is created. The
 * learner is shown a generic message; the reason is recorded for staff (attempt + audit log) only.
 *
 * The move is one conditional update (only while IN_PROGRESS), so concurrent terminations — or a
 * termination racing the learner's submit or the deadline — leave exactly one outcome. Attempts whose
 * time already ran out are closed (auto-submitted) first, so a termination never overrides that.
 * It works whatever the assessment's status (live, paused, or ended with full-duration attempts
 * still running) and never changes the assessment itself: closing the assessment is "End now".
 */

/** A staff action's mandatory reason (kept for staff; the learner never sees it). */
export function parseActionReason(raw: unknown, action: "terminating" | "locking") {
  const parsed = z
    .string({ error: `Enter the reason for ${action}` })
    .trim()
    .min(3, `Enter the reason for ${action} (at least 3 characters)`)
    .max(500, "Keep the reason under 500 characters")
    .safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message, { reason: [parsed.error.issues[0].message] });
  return parsed.data;
}

const parseReason = (raw: unknown) => parseActionReason(raw, "terminating");

export const STATUS_WORD: Partial<Record<AttemptStatus, string>> = {
  SUBMITTED: "has already been submitted",
  AUTO_SUBMITTED: "was already submitted at its deadline",
  TERMINATED: "has already been terminated",
};

/**
 * Terminate one learner's running attempt of an assessment: an administrator, or a proctor assigned
 * to that assessment (anyone else: forbidden; an unassigned proctor or an attempt of another
 * assessment: "not found").
 */
export async function terminateAttempt(actor: SessionUser, input: { assessmentId: string; attemptId: string; reason: unknown }, now: Date = new Date()) {
  await assertCanProctor(actor, input.assessmentId);
  const reason = parseReason(input.reason);
  const attempt = await db.assessmentAttempt.findFirst({
    where: { id: input.attemptId, assessmentId: input.assessmentId, candidate: { assessmentId: input.assessmentId } },
    select: { id: true, candidateId: true, learnerId: true, status: true, learner: { select: { name: true } } },
  });
  if (!attempt) throw new NotFoundError("Attempt not found in this assessment.");
  if (attempt.status !== AttemptStatus.IN_PROGRESS) throw new ConflictError(`This attempt ${STATUS_WORD[attempt.status] ?? "isn’t in progress"}.`);
  await closeExpiredAttempts(now, input.assessmentId);

  return transaction(async (tx) => {
    const { count } = await tx.assessmentAttempt.updateMany({
      where: { id: attempt.id, assessmentId: input.assessmentId, status: AttemptStatus.IN_PROGRESS },
      data: { status: AttemptStatus.TERMINATED, terminatedAt: now, terminatedById: actor.id, terminationReason: reason },
    });
    if (count === 0) {
      const current = await tx.assessmentAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true } });
      throw new ConflictError(`This attempt ${STATUS_WORD[current.status] ?? "isn’t in progress"}.`);
    }
    emitMonitoringEvent("ATTEMPT_TERMINATED", input.assessmentId, attempt.id, now);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ATTEMPT_TERMINATED,
        entityType: "AssessmentAttempt",
        entityId: attempt.id,
        metadata: { assessmentId: input.assessmentId, candidateId: attempt.candidateId, learnerId: attempt.learnerId, reason, terminatedAt: now.toISOString(), actorRole: actor.role },
      },
      tx,
    );
    return { attemptId: attempt.id, learnerName: attempt.learner.name, terminatedAt: now };
  });
}

/**
 * Terminate every attempt of the assessment that is in progress right now. Submitted and already
 * terminated attempts are untouched, and candidates who never started get no attempt. Each affected
 * attempt gets its own audit entry, linked to one bulk entry by a shared operation id.
 */
export async function terminateAllActiveAttempts(actor: SessionUser, input: { assessmentId: string; reason: unknown }, now: Date = new Date()) {
  assertAdmin(actor);
  const reason = parseReason(input.reason);
  const assessment = await db.assessment.findUnique({ where: { id: input.assessmentId }, select: { id: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  await closeExpiredAttempts(now, input.assessmentId);
  const operationId = randomUUID();

  return transaction(async (tx) => {
    const terminated = await tx.$queryRaw<{ id: string; candidateId: string; learnerId: string }[]>`
      UPDATE "assessment_attempts"
         SET "status" = 'TERMINATED', "terminatedAt" = ${now}, "terminatedById" = ${actor.id}, "terminationReason" = ${reason}, "updatedAt" = ${now}
       WHERE "assessmentId" = ${input.assessmentId} AND "status" = 'IN_PROGRESS'
      RETURNING "id", "candidateId", "learnerId"`;
    for (const t of terminated) emitMonitoringEvent("ATTEMPT_TERMINATED", input.assessmentId, t.id, now);
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ATTEMPTS_BULK_TERMINATED,
        entityType: "Assessment",
        entityId: input.assessmentId,
        metadata: { operationId, reason, terminated: terminated.length, attemptIds: terminated.map((t) => t.id), terminatedAt: now.toISOString() },
      },
      tx,
    );
    if (terminated.length) {
      await tx.auditLog.createMany({
        data: terminated.map((t) => ({
          actorId: actor.id,
          action: AuditAction.ATTEMPT_TERMINATED,
          entityType: "AssessmentAttempt",
          entityId: t.id,
          metadata: { assessmentId: input.assessmentId, candidateId: t.candidateId, learnerId: t.learnerId, reason, terminatedAt: now.toISOString(), bulkOperationId: operationId },
        })),
      });
    }
    return { terminated: terminated.length, operationId };
  });
}
