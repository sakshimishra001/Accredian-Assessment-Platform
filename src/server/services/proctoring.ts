import "server-only";
import { ownAttemptWhere } from "@/lib/learner/ownership";
import { Role } from "@/generated/prisma/enums";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { SessionUser } from "../auth/session";
import { db } from "../db";
import { assertAssigned } from "./evaluations";
import { assertCanProctor } from "./proctor-assignments";

/*
 * Reading proctoring events. Events are written only by recordProctoringEvent (attempts.ts) and are
 * append-only: there is no update or delete anywhere in the application.
 *
 * Who may read an attempt's events: an admin (any attempt); the examiner the candidate is assigned
 * to (the attempts they evaluate); the learner (their own attempt); a proctor (reviewer role) the
 * attempts of assessments they are assigned to (assertCanProctor).
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
    case Role.REVIEWER: {
      // A proctor: only attempts of an assessment they are assigned to (anything else is "not found").
      const attempt = await db.assessmentAttempt.findUnique({ where: { id: attemptId }, select: { assessmentId: true } });
      if (!attempt) throw new NotFoundError("Attempt not found.");
      await assertCanProctor(actor, attempt.assessmentId).catch((err) => {
        throw err instanceof NotFoundError ? new NotFoundError("Attempt not found.") : err;
      });
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
