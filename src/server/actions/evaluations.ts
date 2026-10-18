"use server";

import { revalidatePath } from "next/cache";
import { Role } from "@/lib/auth/rbac";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { finalizeEvaluation, saveEvaluation } from "../services/evaluations";

/*
 * Examiner evaluation actions. The session must be an EXAMINER (requireRole redirects otherwise;
 * it stays outside runAction so the redirect isn't swallowed). The attempt id from the browser is
 * only a lookup key: the evaluation service matches it against candidates assigned to this
 * examiner, so another examiner's (or an unassigned) attempt is simply "not found". Mark limits,
 * which answers may be marked, and the finalize rules all live in the service.
 */

function refresh(attemptId: string) {
  revalidatePath("/examiner", "layout");
  revalidatePath("/admin/results", "layout");
  revalidatePath(`/examiner/evaluations/${attemptId}`);
}

/** Save marks (and optional comments) for written answers. Can be repeated until finalized. */
export async function saveEvaluationAction(attemptId: string, marks: unknown): Promise<ActionResult<{ saved: number }>> {
  const actor = await requireRole(Role.EXAMINER);
  const result = await runAction(() => saveEvaluation(actor, attemptId, { marks }));
  if (result.ok) refresh(attemptId);
  return result;
}

/** Finalize: every answered written question must have marks. Marks are then locked. */
export async function finalizeEvaluationAction(attemptId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.EXAMINER);
  const result = await runAction(async () => void (await finalizeEvaluation(actor, attemptId)));
  if (result.ok) refresh(attemptId);
  return result;
}
