import { describe, expect, it } from "vitest";
import {
  ALL_ROLES,
  canAccessPath,
  getHomePath,
  hasRole,
  isProtectedPath,
  resolvePostLoginPath,
  Role,
} from "@/lib/auth/rbac";

describe("canAccessPath", () => {
  const matrix: Array<[string, Role, boolean]> = [
    ["/admin", Role.ADMIN, true],
    ["/admin/anything/nested", Role.ADMIN, true],
    ["/admin", Role.LEARNER, false],
    ["/admin", Role.EXAMINER, false],
    ["/learner", Role.LEARNER, true],
    ["/learner/x", Role.ADMIN, false],
    ["/learner", Role.EXAMINER, false],
    ["/examiner", Role.EXAMINER, true],
    ["/examiner", Role.ADMIN, false],
    ["/examiner", Role.LEARNER, false],
  ];

  it.each(matrix)("%s as %s → %s", (path, role, expected) => {
    expect(canAccessPath(role, path)).toBe(expected);
  });

  it("denies protected paths to anonymous users", () => {
    expect(canAccessPath(null, "/admin")).toBe(false);
    expect(canAccessPath(undefined, "/learner")).toBe(false);
  });

  it("allows public paths for everyone", () => {
    expect(canAccessPath(null, "/login")).toBe(true);
    expect(canAccessPath(Role.LEARNER, "/forbidden")).toBe(true);
  });

  it("does not treat look-alike prefixes as protected", () => {
    expect(isProtectedPath("/administrator")).toBe(false);
    expect(isProtectedPath("/learners")).toBe(false);
    expect(isProtectedPath("/admin")).toBe(true);
  });

  it("gives every role a home it can access and no other role can", () => {
    for (const role of ALL_ROLES) {
      const home = getHomePath(role);
      expect(canAccessPath(role, home)).toBe(true);
      for (const other of ALL_ROLES.filter((r) => r !== role)) {
        expect(canAccessPath(other, home)).toBe(false);
      }
    }
  });
});

describe("hasRole", () => {
  it("checks membership", () => {
    expect(hasRole(Role.ADMIN, [Role.ADMIN, Role.EXAMINER])).toBe(true);
    expect(hasRole(Role.LEARNER, [Role.ADMIN])).toBe(false);
    expect(hasRole(null, [Role.ADMIN])).toBe(false);
  });
});

describe("resolvePostLoginPath", () => {
  it("defaults to the role home", () => {
    expect(resolvePostLoginPath(Role.ADMIN, undefined)).toBe("/admin");
    expect(resolvePostLoginPath(Role.LEARNER, "")).toBe("/learner");
  });

  it("honours an allowed internal path including query string", () => {
    expect(resolvePostLoginPath(Role.ADMIN, "/admin/reports?x=1")).toBe("/admin/reports?x=1");
  });

  it("ignores paths the role cannot access", () => {
    expect(resolvePostLoginPath(Role.LEARNER, "/admin")).toBe("/learner");
    expect(resolvePostLoginPath(Role.EXAMINER, "/learner/results")).toBe("/examiner");
  });

  it.each(["https://evil.example.com/admin", "//evil.example.com/admin", "/\\evil.example.com", "javascript:alert(1)"])(
    "rejects external redirect %s",
    (next) => {
      expect(resolvePostLoginPath(Role.ADMIN, next)).toBe("/admin");
    },
  );

  it("ignores public paths such as /login to avoid loops", () => {
    expect(resolvePostLoginPath(Role.ADMIN, "/login")).toBe("/admin");
  });
});
