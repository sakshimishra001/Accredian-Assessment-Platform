import "server-only";
import type { Role } from "@/lib/auth/rbac";
import { UI_ROLE, type AuthUser } from "@/lib/auth/ui-role";
import { requireRole } from "./guards";

/**
 * Gate for an application area (/admin, /examiner, /reviewer, /learner). Validates the session
 * against the database and the role, redirecting to /login or /forbidden otherwise, and returns
 * only the fields the client shell needs.
 */
export async function requireAreaUser(role: Role): Promise<AuthUser> {
  const user = await requireRole(role);
  return { name: user.name, email: user.email, role: UI_ROLE[user.role] };
}
