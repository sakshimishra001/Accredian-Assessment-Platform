"use server";

import { revalidatePath } from "next/cache";
import { Role } from "@/lib/auth/rbac";
import type { LockedBy, TerminatedBy } from "@/lib/learner/staff-action";
import { NotFoundError } from "@/lib/errors";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { forAssessment } from "../auth/session";
import { getMyAttemptClock, recordFocusViolation, recordProctoringEvent, saveResponses, startOrResumeAttempt, submitAttempt, type FocusOutcome, type ProctoringOutcome } from "../services/attempts";
import { removeAnswerFile } from "../services/files";

/*
 * Learner exam actions. Each requires a learner session (requireRole redirects otherwise; it
 * stays outside runAction so the redirect isn't swallowed). Identity comes only from that session;
 * an assessment or attempt id sent by the browser is checked by the service against the learner's
 * own assignments and attempts, so anything else is simply "not found".
 * Eligibility, timing, snapshot validation and idempotency all live in the attempt service.
 */

function refresh() {
  revalidatePath("/learner", "layout");
}

/** Start the learner's attempt at one of their assigned assessments, or resume the one in progress. */
export async function startAttemptAction(assessmentId: string): Promise<ActionResult<{ attemptId: string }>> {
  const actor = await requireRole(Role.LEARNER);
  const result = await runAction(async () => {
    if (typeof assessmentId !== "string" || !assessmentId) throw new NotFoundError("Assessment not found.");
    return { attemptId: (await startOrResumeAttempt(forAssessment(actor, assessmentId))).attempt.id };
  });
  if (result.ok) refresh();
  return result;
}

/**
 * Autosave changed answers. Safe to repeat: identical saves change nothing and a delayed save with
 * an older clientSeq is ignored. Returns the server's remaining time so the countdown stays aligned.
 */
export async function saveResponsesAction(attemptId: string, responses: unknown): Promise<ActionResult<{ saved: number; ignored: number; remainingSeconds: number; savedAt: Date }>> {
  const actor = await requireRole(Role.LEARNER);
  return runAction(async () => {
    const r = await saveResponses(actor, attemptId, { responses });
    return { saved: r.saved, ignored: r.ignored, remainingSeconds: r.remainingSeconds, savedAt: r.savedAt };
  });
}

/** Submit with any last unsaved answers. Submitting again returns the same outcome. */
export async function submitAttemptAction(
  attemptId: string,
  responses: unknown = [],
): Promise<ActionResult<{ status: string; savedResponses: number; alreadySubmitted: boolean; lateAnswersIgnored: boolean }>> {
  const actor = await requireRole(Role.LEARNER);
  const result = await runAction(async () => {
    const r = await submitAttempt(actor, attemptId, { responses });
    return { status: r.status, savedResponses: r.savedResponses, alreadySubmitted: r.alreadySubmitted, lateAnswersIgnored: r.lateAnswersIgnored };
  });
  if (result.ok) refresh();
  return result;
}

/** The attempt's clock (remaining time, paused or not) as the server sees it now. Polled by the exam screen. */
export async function attemptClockAction(
  attemptId: string,
): Promise<ActionResult<{ status: string; paused: boolean; locked: boolean; lockedBy: LockedBy | null; terminatedByFocus: boolean; terminatedBy: TerminatedBy | null; remainingSeconds: number }>> {
  const actor = await requireRole(Role.LEARNER);
  return runAction(() => getMyAttemptClock(actor, attemptId));
}

/**
 * Report that the learner left the exam (focus monitoring). Only an incident id is sent; the server
 * decides whether it counts and keeps the count, and applies the lock / termination at the limit.
 */
export async function reportFocusLossAction(
  attemptId: string,
  incidentId: string,
): Promise<ActionResult<{ recorded: boolean; outcome: FocusOutcome; violations: number; maxViolations: number }>> {
  const actor = await requireRole(Role.LEARNER);
  const result = await runAction(() => recordFocusViolation(actor, attemptId, incidentId));
  if (result.ok && result.data!.outcome !== "WARNING" && result.data!.outcome !== "IGNORED") refresh();
  return result;
}

/**
 * Report a proctoring event for the learner's own running attempt (type, incident id, optional
 * duration and small details only). The server decides the time, whether it counts, the violation
 * number, severity and action; a learner can't report for another attempt or edit past events.
 */
export async function recordProctoringEventAction(
  attemptId: string,
  event: unknown,
): Promise<ActionResult<{ recorded: boolean; outcome: ProctoringOutcome; violations: number; maxViolations: number; eventId: string | null }>> {
  const actor = await requireRole(Role.LEARNER);
  const result = await runAction(() => recordProctoringEvent(actor, attemptId, event));
  if (result.ok && (result.data!.outcome === "LOCKED" || result.data!.outcome === "TERMINATED")) refresh();
  return result;
}

/** Remove an uploaded file from an answer in the learner's own open attempt. */
export async function removeAnswerFileAction(attemptId: string, attachmentId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.LEARNER);
  return runAction(async () => void (await removeAnswerFile(actor, attemptId, attachmentId)));
}
