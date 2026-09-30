import "server-only";
import { hasRole, type Role } from "@/lib/auth/rbac";
import { ForbiddenError } from "@/lib/errors";
import type { SessionUser } from "./auth/session";

/**
 * Service-layer authorization. Pages and actions already call requireRole(); services check
 * again so they are safe no matter where they are called from (actions, route handlers, scripts).
 */
export function assertRole(actor: SessionUser | null | undefined, ...roles: Role[]): asserts actor is SessionUser {
  if (!actor || !hasRole(actor.role, roles)) throw new ForbiddenError();
}

export function assertAdmin(actor: SessionUser | null | undefined): asserts actor is SessionUser {
  assertRole(actor, "ADMIN");
}
