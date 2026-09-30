"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AssessmentStatus } from "@/generated/prisma/enums";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { formToObject, runAction, type ActionResult, type FormState } from "@/server/action-result";
import { requireRole } from "@/server/auth/guards";
import {
  addQuestionsToAssessment,
  createAssessment,
  moveQuestionInAssessment,
  refreshAssessmentQuestion,
  removeQuestionFromAssessment,
  transitionAssessment,
  updateAssessment,
  updateAssessmentQuestionMarks,
} from "@/server/services/assessments";

function refresh(id?: string) {
  revalidatePath("/admin/assessments");
  if (id) revalidatePath(`/admin/assessments/${id}`);
}

export async function createAssessmentAction(_prev: FormState, formData: FormData): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => createAssessment(actor, formToObject(formData)));
  if (!result.ok) return result;
  refresh();
  redirect(`/admin/assessments/${result.data!.id}`);
}

export async function updateAssessmentAction(id: string, _prev: FormState, formData: FormData): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => updateAssessment(actor, id, formToObject(formData)));
  if (!result.ok) return result;
  refresh(id);
  redirect(`/admin/assessments/${id}`);
}

export async function transitionAssessmentAction(id: string, to: AssessmentStatus): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => transitionAssessment(actor, id, to));
  if (!result.ok) return result;
  refresh(id);
  return { ok: true, message: `Moved to ${STATUS_LABEL[to]}.` };
}

export async function addQuestionsAction(id: string, _prev: FormState, formData: FormData): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const ids = formData.getAll("questionIds").filter((v): v is string => typeof v === "string");
  const result = await runAction(() => addQuestionsToAssessment(actor, id, ids));
  if (!result.ok) return result;
  refresh(id);
  redirect(`/admin/assessments/${id}#questions`);
}

export async function removeQuestionAction(id: string, assessmentQuestionId: string): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => removeQuestionFromAssessment(actor, id, assessmentQuestionId));
  if (result.ok) refresh(id);
  return result.ok ? { ok: true } : result;
}

export async function moveQuestionAction(id: string, assessmentQuestionId: string, direction: "up" | "down"): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => moveQuestionInAssessment(actor, id, assessmentQuestionId, direction));
  if (result.ok) refresh(id);
  return result.ok ? { ok: true } : result;
}

export async function updateQuestionMarksAction(
  id: string,
  assessmentQuestionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => updateAssessmentQuestionMarks(actor, id, assessmentQuestionId, formToObject(formData)));
  if (!result.ok) return result;
  refresh(id);
  return { ok: true, message: "Saved" };
}

export async function refreshAssessmentQuestionAction(id: string, assessmentQuestionId: string): Promise<ActionResult> {
  const actor = await requireRole("ADMIN");
  const result = await runAction(() => refreshAssessmentQuestion(actor, id, assessmentQuestionId));
  if (result.ok) refresh(id);
  return result.ok ? { ok: true } : result;
}
