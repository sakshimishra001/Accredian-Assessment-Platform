import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/session";

const getCurrentUser = vi.fn<() => Promise<SessionUser | null>>();

vi.mock("@/server/auth/current-user", () => ({ getCurrentUser: () => getCurrentUser() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}

const { requireRole, requireUser } = await import("@/server/auth/guards");

const user = (role: SessionUser["role"]): SessionUser => ({
  id: "u1",
  email: "u@example.com",
  name: "U",
  role,
});

describe("requireUser", () => {
  beforeEach(() => getCurrentUser.mockReset());

  it("redirects anonymous visitors to /login", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireUser()).rejects.toMatchObject({ url: "/login" });
  });

  it("returns the signed-in user", async () => {
    getCurrentUser.mockResolvedValue(user("LEARNER"));
    await expect(requireUser()).resolves.toMatchObject({ role: "LEARNER" });
  });
});

describe("requireRole", () => {
  beforeEach(() => getCurrentUser.mockReset());

  it("redirects anonymous visitors to /login", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireRole("ADMIN")).rejects.toMatchObject({ url: "/login" });
  });

  it("redirects anonymous visitors to a learner page to the learner sign-in (no role choice)", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireRole("LEARNER")).rejects.toMatchObject({ url: "/learner/login" });
  });

  it.each([
    ["LEARNER", "ADMIN"],
    ["EXAMINER", "ADMIN"],
    ["ADMIN", "LEARNER"],
    ["EXAMINER", "LEARNER"],
    ["ADMIN", "EXAMINER"],
    ["LEARNER", "EXAMINER"],
    ["REVIEWER", "ADMIN"],
    ["REVIEWER", "EXAMINER"],
    ["REVIEWER", "LEARNER"],
    ["LEARNER", "REVIEWER"],
    ["EXAMINER", "REVIEWER"],
    ["ADMIN", "REVIEWER"],
  ] as const)("sends %s to /forbidden for %s-only areas", async (actual, required) => {
    getCurrentUser.mockResolvedValue(user(actual));
    await expect(requireRole(required)).rejects.toMatchObject({ url: "/forbidden" });
  });

  it.each(["ADMIN", "EXAMINER", "REVIEWER", "LEARNER"] as const)("allows %s into its own area", async (role) => {
    getCurrentUser.mockResolvedValue(user(role));
    await expect(requireRole(role)).resolves.toMatchObject({ role });
  });

  it("allows any of several roles", async () => {
    getCurrentUser.mockResolvedValue(user("ADMIN"));
    await expect(requireRole("EXAMINER", "ADMIN")).resolves.toMatchObject({ role: "ADMIN" });
  });
});
