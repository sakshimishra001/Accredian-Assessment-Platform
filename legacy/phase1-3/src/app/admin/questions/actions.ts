"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formToObject, runAction, type ActionResult, type FormState } from "@/server/action-result";
import { requireRole } from "@/server/auth/guards";
import { createQuestion, deleteQuestion, setQuestionArchived, updateQuestion } from "@/server/services/questions";

export async function createQuestionAction(_prev: FormState, formData: FormData): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => createQuestion(actor, formToObject(formData)));
  if (!result.ok) return result;
  revalidatePath("/admin/questions");
  redirect(`/admin/questions/${result.data!.id}`);
}

export async function updateQuestionAction(id: string, _prev: FormState, formData: FormData): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => updateQuestion(actor, id, formToObject(formData)));
  if (!result.ok) return result;
  revalidatePath("/admin/questions");
  redirect(`/admin/questions/${id}`);
}

export async function setQuestionArchivedAction(id: string, archived: boolean): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => setQuestionArchived(actor, id, archived));
  if (result.ok) {
    revalidatePath("/admin/questions");
    revalidatePath(`/admin/questions/${id}`);
  }
  return result.ok ? { ok: true } : result;
}

/** Permanent delete — only for questions never used in an assessment (the service enforces this). */
export async function deleteQuestionAction(id: string): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => deleteQuestion(actor, id));
  if (!result.ok) return result;
  revalidatePath("/admin/questions");
  redirect("/admin/questions");
}
