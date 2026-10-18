"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UserStatus } from "@/generated/prisma/enums";
import { Role } from "@/lib/auth/rbac";
import { formToObject, runAction, type ActionResult, type FormState } from "../action-result";
import { getRequestMeta } from "../auth/current-user";
import { requireRole } from "../auth/guards";
import { createStaffAccount, issuePasswordReset, reissueInvite, setPasswordWithToken, setStaffStatus, type PasswordLink } from "../services/staff";

/*
 * Staff account actions. The admin ones check the session and the ADMIN role first (requireRole
 * redirects otherwise; it stays outside runAction), then call the staff service, which re-checks.
 * The one-time link is returned to the administrator once and never stored in plain form.
 */

const USERS = "/admin/users";

function refresh() {
  revalidatePath(USERS);
  revalidatePath("/admin/examiners", "layout");
}

export async function createStaffAccountAction(input: unknown): Promise<ActionResult<{ id: string; link: PasswordLink }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const { user, link } = await createStaffAccount(actor, input);
    return { id: user.id, link };
  });
  if (result.ok) refresh();
  return result;
}

export async function resetStaffPasswordAction(userId: string): Promise<ActionResult<PasswordLink>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(() => issuePasswordReset(actor, userId));
  if (result.ok) refresh();
  return result;
}

export async function reissueInviteAction(userId: string): Promise<ActionResult<PasswordLink>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(() => reissueInvite(actor, userId));
  if (result.ok) refresh();
  return result;
}

export async function setStaffStatusAction(userId: string, active: boolean): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await setStaffStatus(actor, userId, active ? UserStatus.ACTIVE : UserStatus.DISABLED)));
  if (result.ok) refresh();
  return result;
}

/** Public (link holder): set a password with a one-time link, then sign in. */
export async function setPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await runAction(async () => {
    await setPasswordWithToken(formToObject(formData), await getRequestMeta());
  });
  if (!result.ok) return result;
  redirect("/login?password=set");
}
