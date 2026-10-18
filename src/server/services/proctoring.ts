import "server-only";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { Role } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { SessionUser } from "../auth/session";
import { db } from "../db";
import { assertAssigned } from "./evaluations";

/*
 * Reading proctoring events. Events are written only by recordProctoringEvent (attempts.ts) and are
 * append-only: there is no update or delete anywhere in the application.
 *
 * Who may read an attempt's events: an admin (any attempt); the examiner the candidate is assigned
 * to (the attempts they evaluate); the learner (their own attempt). Proctors
 * (the reviewer role) have no access to attempts in the current RBAC model.
 * Anything else is "not found" (or forbidden for a role with no access at all).
 */

async function assertCanRead(actor: SessionUser, attemptId: string) {
  switch (actor.role) {
    case Role.ADMIN: {
      if (!(await db.assessmentAttempt.count({ where: { id: attemptId } }))) throw new NotFoundError("Attempt not found.");
      return;
    }
    case Role.EXAMINER:
      await assertAssigned(db, actor, attemptId);
      return;
    case Role.LEARNER: {
      const own = await db.assessmentAttempt.count({ where: ownAttemptWhere(actor.id, attemptId) });
      if (!own) throw new NotFoundError("Attempt not found.");
      return;
    }
    default:
      throw new ForbiddenError();
  }
}

/** An attempt's proctoring events, oldest first. */
export async function listAttemptProctoringEvents(actor: SessionUser, attemptId: string) {
  await assertCanRead(actor, attemptId);
  return db.proctoringEvent.findMany({
    where: { attemptId },
    orderBy: [{ timestamp: "asc" }, { createdAt: "asc" }],
    select: { id: true, eventType: true, severity: true, timestamp: true, durationMs: true, violationNumber: true, actionTaken: true, metadata: true },
  });
}
