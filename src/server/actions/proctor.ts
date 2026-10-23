"use server";

import { revalidatePath } from "next/cache";
import { Role } from "@/lib/auth/rbac";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { lockAttempt } from "../services/attempt-lock";
import { terminateAttempt } from "../services/attempt-termination";

/*
 * Proctor dashboard actions (phase 3): lock or terminate one learner's running attempt. Each
 * requires a proctor or administrator session (requireRole redirects otherwise; it stays outside
 * runAction so the redirect isn't swallowed); the services then check everything again on the
 * server — assignment to the assessment, that the attempt belongs to it and is still running — and
 * record the actor and reason in the audit log. The learner's exam picks the change up on its own
 * next clock poll.
 */

function refresh(assessmentId: string, attemptId: string) {
  revalidatePath("/proctor");
  revalidatePath(`/proctor/assessments/${assessmentId}`);
  revalidatePath(`/proctor/assessments/${assessmentId}/attempts/${attemptId}`);
  revalidatePath(`/admin/assessments/${assessmentId}`);
  revalidatePath("/learner", "layout");
}

/** Lock a running attempt (a reason is required; the learner never sees it). */
export async function lockAttemptAction(assessmentId: string, attemptId: string, reason: string): Promise<ActionResult<{ learnerName: string }>> {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const result = await runAction(async () => ({ learnerName: (await lockAttempt(actor, { assessmentId, attemptId, reason })).learnerName }));
  if (result.ok) refresh(assessmentId, attemptId);
  return result;
}

/** Terminate a running attempt (a reason is required; the learner never sees it). */
export async function terminateMonitoredAttemptAction(assessmentId: string, attemptId: string, reason: string): Promise<ActionResult<{ learnerName: string }>> {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const result = await runAction(async () => ({ learnerName: (await terminateAttempt(actor, { assessmentId, attemptId, reason })).learnerName }));
  if (result.ok) {
    refresh(assessmentId, attemptId);
    revalidatePath("/admin/results", "layout");
  }
  return result;
}
