import "server-only";
import { redirect } from "next/navigation";
import { hasRole, type Role } from "@/lib/auth/rbac";
import { getCurrentUser } from "./current-user";
import type { SessionUser } from "./session";

/**
 * Use at the top of every protected page, server action and route handler.
 * Layouts are not re-rendered on client navigation, so page-level checks are the real gate.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Signed-in user holding one of `roles`; otherwise redirect to login or the 403 page. */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasRole(user.role, roles)) redirect("/forbidden");
  return user;
}
