import { Role } from "@/generated/prisma/enums";

export { Role };

export const ALL_ROLES: readonly Role[] = [Role.ADMIN, Role.LEARNER, Role.EXAMINER];

/** Each role's landing page after login. */
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  LEARNER: "/learner",
  EXAMINER: "/examiner",
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  LEARNER: "Learner",
  EXAMINER: "Examiner",
};

/**
 * Route prefixes that require authentication, and the roles allowed under each.
 * Anything not listed here is public (e.g. /login).
 */
export const PROTECTED_ROUTES: ReadonlyArray<{ prefix: string; roles: readonly Role[] }> = [
  { prefix: "/admin", roles: [Role.ADMIN] },
  { prefix: "/learner", roles: [Role.LEARNER] },
  { prefix: "/examiner", roles: [Role.EXAMINER] },
];

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function findProtectedRoute(pathname: string) {
  return PROTECTED_ROUTES.find((r) => matchesPrefix(pathname, r.prefix));
}

export function isProtectedPath(pathname: string): boolean {
  return findProtectedRoute(pathname) !== undefined;
}

export function hasRole(role: Role | null | undefined, allowed: readonly Role[]): boolean {
  return role != null && allowed.includes(role);
}

/** Whether a user with `role` may open `pathname`. Unprotected paths are open to everyone. */
export function canAccessPath(role: Role | null | undefined, pathname: string): boolean {
  const route = findProtectedRoute(pathname);
  if (!route) return true;
  return hasRole(role, route.roles);
}

export function getHomePath(role: Role): string {
  return ROLE_HOME[role];
}

/**
 * Resolve where to send a user after login. Only same-origin relative paths the role may
 * access are honoured; everything else falls back to the role's home (prevents open redirects).
 */
export function resolvePostLoginPath(role: Role, next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return getHomePath(role);
  }
  let pathname: string;
  try {
    const url = new URL(next, "http://local.invalid");
    if (url.origin !== "http://local.invalid") return getHomePath(role);
    pathname = url.pathname;
  } catch {
    return getHomePath(role);
  }
  if (!isProtectedPath(pathname) || !canAccessPath(role, pathname)) return getHomePath(role);
  return next;
}
