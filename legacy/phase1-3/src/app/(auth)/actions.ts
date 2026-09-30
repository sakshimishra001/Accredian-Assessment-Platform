"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { resolvePostLoginPath } from "@/lib/auth/rbac";
import { loginSchema } from "@/lib/validation/auth";
import { AuditAction, recordAudit } from "@/server/audit";
import {
  clearSessionCookie,
  getCurrentUser,
  getRequestMeta,
  readSessionToken,
  setSessionCookie,
} from "@/server/auth/current-user";
import { login } from "@/server/auth/service";
import { invalidateSession } from "@/server/auth/session";

export interface LoginFormState {
  error?: string;
  fieldErrors?: Partial<Record<"email" | "password", string[]>>;
  email?: string;
}

const LOGIN_ERRORS = {
  invalid_credentials: "Incorrect email or password.",
  account_disabled: "This account is disabled. Contact your administrator.",
} as const;

export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") || undefined,
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    return { fieldErrors: { email: fieldErrors.email, password: fieldErrors.password }, email };
  }

  let destination: string;
  try {
    const result = await login(parsed.data.email, parsed.data.password, await getRequestMeta());
    if (!result.ok) return { error: LOGIN_ERRORS[result.reason], email };
    await setSessionCookie(result.token, result.expiresAt);
    destination = resolvePostLoginPath(result.user.role, parsed.data.next);
  } catch (err) {
    console.error("[auth] login failed unexpectedly", err);
    return { error: "Something went wrong while signing in. Please try again.", email };
  }
  // redirect() throws, so it must stay outside the try/catch.
  redirect(destination);
}

export async function logoutAction() {
  const token = await readSessionToken();
  if (token) {
    const user = await getCurrentUser();
    await invalidateSession(token);
    if (user) {
      const meta = await getRequestMeta();
      await recordAudit({
        actorId: user.id,
        action: AuditAction.LOGOUT,
        entityType: "User",
        entityId: user.id,
        ipAddress: meta.ipAddress,
      });
    }
  }
  await clearSessionCookie();
  redirect("/login");
}
