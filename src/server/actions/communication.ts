"use server";

import { revalidatePath } from "next/cache";
import { Role } from "@/lib/auth/rbac";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { createTemplate, duplicateTemplate, saveAssessmentCommunication, updateTemplate } from "../services/communication";

/*
 * Communication actions (ADMIN only; requireRole redirects otherwise and the services re-check).
 * Template content is validated by the service: allowlisted {{variables}} only.
 */

function refresh(templateId?: string) {
  revalidatePath("/admin/communication", "layout");
  if (templateId) revalidatePath(`/admin/communication/templates/${templateId}`);
}

export async function createTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ id: (await createTemplate(actor, input)).id }));
  if (result.ok) refresh(result.data!.id);
  return result;
}

export async function updateTemplateAction(id: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await updateTemplate(actor, id, input)));
  if (result.ok) refresh(id);
  return result;
}

export async function duplicateTemplateAction(id: string): Promise<ActionResult<{ id: string; name: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const t = await duplicateTemplate(actor, id);
    return { id: t.id, name: t.name };
  });
  if (result.ok) refresh(result.data!.id);
  return result;
}

/** The Assessment Builder's Communication step. */
export async function saveAssessmentCommunicationAction(assessmentId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await saveAssessmentCommunication(actor, assessmentId, input)));
  if (result.ok) {
    revalidatePath(`/admin/assessments/${assessmentId}`);
    revalidatePath("/admin/assessments/new");
    refresh();
  }
  return result;
}
