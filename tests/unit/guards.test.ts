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

  it.each([
    ["LEARNER", "ADMIN"],
    ["EXAMINER", "ADMIN"],
    ["ADMIN", "LEARNER"],
    ["EXAMINER", "LEARNER"],
    ["ADMIN", "EXAMINER"],
    ["LEARNER", "EXAMINER"],
  ] as const)("sends %s to /forbidden for %s-only areas", async (actual, required) => {
    getCurrentUser.mockResolvedValue(user(actual));
    await expect(requireRole(required)).rejects.toMatchObject({ url: "/forbidden" });
  });

  it("allows a matching role", async () => {
    getCurrentUser.mockResolvedValue(user("EXAMINER"));
    await expect(requireRole("EXAMINER")).resolves.toMatchObject({ role: "EXAMINER" });
  });

  it("allows any of several roles", async () => {
    getCurrentUser.mockResolvedValue(user("ADMIN"));
    await expect(requireRole("EXAMINER", "ADMIN")).resolves.toMatchObject({ role: "ADMIN" });
  });
});
