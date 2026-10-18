"use server";

import { revalidatePath } from "next/cache";
import { AssessmentStatus } from "@/generated/prisma/enums";
import { Role } from "@/lib/auth/rbac";
import { ValidationError } from "@/lib/errors";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { transitionAssessment } from "../services/assessments";
import { assignExaminer } from "../services/candidates";
import { notify } from "../services/communication";
import { reopenEvaluation } from "../services/results";

/*
 * Admin actions for evaluation and results. ADMIN only (requireRole redirects otherwise); the
 * services re-check the role and own every rule — the assessment lifecycle decides which moves are
 * allowed (e.g. results can't be marked ready while attempts are still being taken or evaluated).
 */

/** Result-stage moves offered on the admin screens. Draft/scheduling moves live in the builder. */
const RESULT_MOVES: readonly AssessmentStatus[] = [AssessmentStatus.ENDED, AssessmentStatus.EVALUATION, AssessmentStatus.RESULT_READY, AssessmentStatus.PUBLISHED];

function refresh(assessmentId: string) {
  revalidatePath("/admin/assessments", "layout");
  revalidatePath("/admin/results", "layout");
  revalidatePath("/examiner", "layout");
  revalidatePath("/learner", "layout");
  revalidatePath(`/admin/assessments/${assessmentId}`);
}

/** End now / start evaluation / mark results ready / publish results (and back to evaluation). */
export async function moveAssessmentAction(assessmentId: string, to: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const target = RESULT_MOVES.find((s) => s === to);
    if (!target) throw new ValidationError("This status change isn’t available here.");
    await transitionAssessment(actor, assessmentId, target);
    return undefined;
  });
  if (result.ok && to === AssessmentStatus.PUBLISHED) await notify(assessmentId, "RESULT_PUBLISHED", actor.id);
  if (result.ok) refresh(assessmentId);
  return result;
}

/** Assign candidates of one assessment to an examiner (null unassigns). */
export async function assignExaminerAction(assessmentId: string, candidateIds: string[], examinerId: string | null): Promise<ActionResult<{ updated: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ updated: await assignExaminer(actor, assessmentId, candidateIds, examinerId) }));
  if (result.ok) refresh(assessmentId);
  return result;
}

/** Reopen a finalized evaluation (with a reason) so the examiner can correct marks before publishing. */
export async function reopenEvaluationAction(assessmentId: string, attemptId: string, reason: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await reopenEvaluation(actor, attemptId, { reason })));
  if (result.ok) {
    refresh(assessmentId);
    revalidatePath(`/examiner/evaluations/${attemptId}`);
  }
  return result;
}
