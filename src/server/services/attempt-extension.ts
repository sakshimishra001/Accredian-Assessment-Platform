import "server-only";
import { emitMonitoringEvent, transaction } from "../realtime/publish";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AttemptStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { closeExpiredAttempts, effectiveDeadline } from "./attempts";

/*
 * Administrator time extensions for running attempts — one learner, selected learners, or every
 * learner of the assessment's batch who is taking it right now.
 *
 * Each grant is its own AttemptTimeExtension row (minutes, reason, who, end before → after); the
 * attempt's extensionSeconds is their running total and its stored deadline moves with it. The
 * effective end (attempts.ts → effectiveDeadline) is start + duration + pauses (capped at the window
 * end in WINDOW mode) + extensions: an explicit administrator override that may run past the window.
 * The assessment's duration and window never change.
 *
 * Only IN_PROGRESS attempts whose time hasn't run out can be extended (expired ones are closed first);
 * submitted and terminated attempts never are, and nobody who hasn't started gets an attempt. Each
 * grant locks its attempt row, so concurrent grants queue and all of them count.
 */

export const MAX_EXTENSION_MINUTES = 180;
export const MAX_TOTAL_EXTENSION_MINUTES = 480;

const extensionSchema = z.object({
  minutes: z.coerce
    .number({ error: "Enter the extra time in minutes" })
    .int("Whole minutes only")
    .min(1, "Add at least 1 minute")
    .max(MAX_EXTENSION_MINUTES, `At most ${MAX_EXTENSION_MINUTES} minutes at a time`),
  reason: z.string({ error: "Enter the reason for the extension" }).trim().min(3, "Enter the reason for the extension (at least 3 characters)").max(500, "Keep the reason under 500 characters"),
});

function parse(raw: { minutes: unknown; reason: unknown }) {
  const parsed = extensionSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, parsed.error.issues[0].message);
  return parsed.data;
}

const NOT_ELIGIBLE: Partial<Record<AttemptStatus, string>> = {
  SUBMITTED: "This attempt has already been submitted; time can’t be extended.",
  AUTO_SUBMITTED: "This attempt has already ended (time was up); time can’t be extended.",
  TERMINATED: "This attempt was terminated; time can’t be extended.",
};

type Grant = { attemptId: string; candidateId: string; learnerId: string; previousEndAt: Date; newEndAt: Date; totalMinutes: number };

/**
 * Extend one attempt inside `tx`: lock it, check it is still running and under the total cap, then
 * record the grant. Returns null (nothing changed) when `skipIneligible` and it isn't eligible.
 */
async function grantOne(tx: DbTx, actor: SessionUser, assessmentId: string, attemptId: string, minutes: number, reason: string, now: Date, bulkOperationId: string | null): Promise<Grant | null> {
  const { count } = await tx.assessmentAttempt.updateMany({ where: { id: attemptId, assessmentId, status: AttemptStatus.IN_PROGRESS }, data: { status: AttemptStatus.IN_PROGRESS } });
  const attempt = await tx.assessmentAttempt.findFirst({
    where: { id: attemptId, assessmentId, candidate: { assessmentId } },
    select: {
      id: true,
      status: true,
      candidateId: true,
      learnerId: true,
      startedAt: true,
      deadlineAt: true,
      pausedSeconds: true,
      extensionSeconds: true,
      assessment: { select: { timingMode: true, endAt: true, durationMinutes: true, pausedAt: true } },
    },
  });
  if (!attempt) throw new NotFoundError("Attempt not found in this assessment.");
  const previousEndAt = effectiveDeadline(attempt, attempt.assessment, now);
  if (count === 0 || attempt.status !== AttemptStatus.IN_PROGRESS || now >= previousEndAt) {
    if (bulkOperationId) return null;
    throw new ConflictError(NOT_ELIGIBLE[attempt.status] ?? "This attempt’s time is already up; time can’t be extended.");
  }
  const totalSeconds = attempt.extensionSeconds + minutes * 60;
  if (totalSeconds > MAX_TOTAL_EXTENSION_MINUTES * 60) {
    if (bulkOperationId) return null;
    throw new ValidationError(`An attempt can be extended by at most ${MAX_TOTAL_EXTENSION_MINUTES} minutes in total (${attempt.extensionSeconds / 60} already granted).`, { minutes: ["Too much extra time"] });
  }

  await tx.assessmentAttempt.update({
    where: { id: attempt.id },
    data: { extensionSeconds: { increment: minutes * 60 }, deadlineAt: new Date(attempt.deadlineAt.getTime() + minutes * 60_000) },
  });
  const newEndAt = effectiveDeadline({ ...attempt, extensionSeconds: totalSeconds, deadlineAt: new Date(attempt.deadlineAt.getTime() + minutes * 60_000) }, attempt.assessment, now);
  await tx.attemptTimeExtension.create({ data: { attemptId: attempt.id, minutes, reason, grantedById: actor.id, previousEndAt, newEndAt, bulkOperationId, createdAt: now } });
  emitMonitoringEvent("ATTEMPT_TIME_EXTENDED", assessmentId, attempt.id, now);
  await recordAudit(
    {
      actorId: actor.id,
      action: AuditAction.ATTEMPT_TIME_EXTENDED,
      entityType: "AssessmentAttempt",
      entityId: attempt.id,
      metadata: {
        assessmentId,
        candidateId: attempt.candidateId,
        learnerId: attempt.learnerId,
        minutes,
        reason,
        previousEndAt: previousEndAt.toISOString(),
        newEndAt: newEndAt.toISOString(),
        totalExtensionMinutes: totalSeconds / 60,
        ...(bulkOperationId ? { bulkOperationId } : {}),
      },
    },
    tx,
  );
  return { attemptId: attempt.id, candidateId: attempt.candidateId, learnerId: attempt.learnerId, previousEndAt, newEndAt, totalMinutes: totalSeconds / 60 };
}

/** Give one learner's running attempt extra time. Errors explain why an attempt can't be extended. */
export async function extendAttempt(actor: SessionUser, input: { assessmentId: string; attemptId: string; minutes: unknown; reason: unknown }, now: Date = new Date()) {
  assertAdmin(actor);
  const { minutes, reason } = parse(input);
  const assessment = await db.assessment.findUnique({ where: { id: input.assessmentId }, select: { id: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  await closeExpiredAttempts(now, input.assessmentId);
  return transaction(async (tx) => (await grantOne(tx, actor, input.assessmentId, input.attemptId, minutes, reason, now, null))!);
}

/**
 * Give extra time to several running attempts: the selected ones, or (scope "BATCH") every attempt of
 * the assessment's batch in progress right now. Attempts that aren't eligible are left unchanged and
 * reported; learners who haven't started are not affected.
 */
export async function extendAttempts(
  actor: SessionUser,
  input: { assessmentId: string; scope: "SELECTED" | "BATCH"; attemptIds?: string[]; minutes: unknown; reason: unknown },
  now: Date = new Date(),
) {
  assertAdmin(actor);
  const { minutes, reason } = parse(input);
  const assessment = await db.assessment.findUnique({ where: { id: input.assessmentId }, select: { id: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  if (input.scope === "SELECTED" && !input.attemptIds?.length) throw new ValidationError("Select at least one learner.");
  await closeExpiredAttempts(now, input.assessmentId);

  const ids =
    input.scope === "BATCH"
      ? (await db.assessmentAttempt.findMany({ where: { assessmentId: input.assessmentId, status: AttemptStatus.IN_PROGRESS }, select: { id: true } })).map((a) => a.id)
      : [...new Set(input.attemptIds)];
  // Every selected id must be an attempt of this assessment (ineligible ones are skipped, unknown ones refused).
  const known = await db.assessmentAttempt.count({ where: { id: { in: ids }, assessmentId: input.assessmentId } });
  if (known !== ids.length) throw new NotFoundError("One or more selected attempts aren’t part of this assessment.");

  const operationId = randomUUID();
  return transaction(async (tx) => {
    const grants: Grant[] = [];
    for (const id of ids.sort()) {
      const g = await grantOne(tx, actor, input.assessmentId, id, minutes, reason, now, operationId);
      if (g) grants.push(g);
    }
    await recordAudit(
      {
        actorId: actor.id,
        action: AuditAction.ATTEMPTS_BULK_TIME_EXTENDED,
        entityType: "Assessment",
        entityId: input.assessmentId,
        metadata: {
          operationId,
          scope: input.scope,
          minutes,
          reason,
          extended: grants.length,
          skipped: ids.length - grants.length,
          attempts: grants.map((g) => ({ attemptId: g.attemptId, candidateId: g.candidateId, learnerId: g.learnerId, previousEndAt: g.previousEndAt.toISOString(), newEndAt: g.newEndAt.toISOString() })),
        },
      },
      tx,
    );
    return { extended: grants.length, skipped: ids.length - grants.length, operationId, grants };
  });
}
