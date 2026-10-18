import "server-only";
import { redirect } from "next/navigation";
import { LEARNER_LOGIN_PATH } from "@/lib/auth/constants";
import { hasRole, Role } from "@/lib/auth/rbac";
import { getCurrentUser } from "./current-user";
import type { SessionUser } from "./session";

/**
 * Use at the top of every protected page, server action and route handler.
 * Layouts are not re-rendered on client navigation, so page-level checks are the real gate.
 */
export async function requireUser(loginPath = "/login"): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(loginPath);
  return user;
}

/** Signed-in user holding one of `roles`; otherwise redirect to sign-in (learner pages: /learner/login) or the 403 page. */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser(roles.length === 1 && roles[0] === Role.LEARNER ? LEARNER_LOGIN_PATH : "/login");
  if (!hasRole(user.role, roles)) redirect("/forbidden");
  return user;
}
