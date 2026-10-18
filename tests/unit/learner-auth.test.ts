import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Learner authentication against an in-memory stand-in for the database (no PostgreSQL needed):
 * one persistent password per learner, checked with bcrypt; sessions that belong to the learner,
 * not to an assessment; staff and learner sign-ins kept apart. (End-to-end against PostgreSQL:
 * tests/integration/learner-password.test.ts.)
 */

type FakeUser = { id: string; email: string; name: string; role: string; status: string; passwordHash: string | null; candidacies?: unknown[] };
const users = new Map<string, FakeUser>();
const sessions: Record<string, unknown>[] = [];
const audits: Record<string, unknown>[] = [];
const userUpdates: unknown[] = [];

vi.mock("@/server/db", () => ({
  db: {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        const u = where.email ? users.get(where.email) : [...users.values()].find((x) => x.id === where.id);
        return u ? { candidacies: [], ...u } : null;
      },
      update: async (args: unknown) => void userUpdates.push(args),
    },
    session: { create: async ({ data }: { data: Record<string, unknown> }) => void sessions.push(data) },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void audits.push(data) },
    examCredential: { update: async () => undefined },
    assessment: { findUnique: async () => ({ publishedAt: null, status: "ACTIVE" }) },
    assessmentCandidate: { findFirst: async () => null },
  },
}));
vi.mock("@/server/services/assessments", () => ({ syncTimeBasedStatuses: async () => undefined }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { hashPassword } = await import("@/server/auth/password");
const { authenticateLearner } = await import("@/server/auth/exam-login");
const { login } = await import("@/server/auth/service");

let learnerHash: string;
let staffHash: string;

beforeEach(async () => {
  users.clear();
  sessions.length = 0;
  audits.length = 0;
  userUpdates.length = 0;
  learnerHash ??= await hashPassword("K7MPQ2X9RT");
  staffHash ??= await hashPassword("correct-horse-battery");
  users.set("lina@example.com", { id: "u-lina", email: "lina@example.com", name: "Lina", role: "LEARNER", status: "ACTIVE", passwordHash: learnerHash });
  users.set("leo@example.com", { id: "u-leo", email: "leo@example.com", name: "Leo", role: "LEARNER", status: "DISABLED", passwordHash: learnerHash });
  users.set("admin@example.com", { id: "u-admin", email: "admin@example.com", name: "Ada", role: "ADMIN", status: "ACTIVE", passwordHash: staffHash });
});

describe("learner password sign-in", () => {
  it("A: the learner's own password signs them in — a learner session, not tied to any one assessment", async () => {
    const r = await authenticateLearner("  LINA@example.com ", "K7MPQ2X9RT");
    expect(r).toMatchObject({ ok: true, method: "password", user: { id: "u-lina", role: "LEARNER" } });
    if (!r.ok) return;
    expect(r.user).not.toHaveProperty("assessmentId");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ userId: "u-lina", examCredentialId: null });
    // The cookie token is opaque: neither the password nor its hash.
    expect(r.token).not.toContain("K7MPQ2X9RT");
    expect(sessions[0].tokenHash).not.toBe(learnerHash);
    // Audited without the password.
    expect(JSON.stringify(audits)).not.toContain("K7MPQ2X9RT");
  }, 20_000);

  it("B: a wrong password, an unknown email or a disabled account doesn't sign in", async () => {
    expect(await authenticateLearner("lina@example.com", "K7MPQ2X9RX")).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateLearner("lina@example.com", "k7mpq2x9rt")).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateLearner("nobody@example.com", "K7MPQ2X9RT")).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateLearner("leo@example.com", "K7MPQ2X9RT")).toEqual({ ok: false, reason: "account_disabled" });
    expect(sessions).toHaveLength(0);
  }, 30_000);

  it("J: staff and learner sign-ins stay apart", async () => {
    // A staff account can't use the learner sign-in…
    expect(await authenticateLearner("admin@example.com", "correct-horse-battery")).toEqual({ ok: false, reason: "invalid_credentials" });
    // …a learner's password can't open a staff session…
    expect(await login("lina@example.com", "K7MPQ2X9RT")).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(sessions).toHaveLength(0);
    // …and staff sign-in is unchanged.
    expect(await login("admin@example.com", "correct-horse-battery")).toMatchObject({ ok: true, user: { role: "ADMIN" } });
  }, 30_000);
});

describe("C: an assessment the learner isn't assigned to", () => {
  it("is \"not found\", whoever knows its id", async () => {
    const { getMyExamOverview } = await import("@/server/services/attempts");
    const { NotFoundError } = await import("@/lib/errors");
    const { forAssessment } = await import("@/server/auth/session");
    const learner = { id: "u-lina", email: "lina@example.com", name: "Lina", role: "LEARNER" as const };
    await expect(getMyExamOverview(forAssessment(learner, "someone-elses-assessment"))).rejects.toBeInstanceOf(NotFoundError);
  });
});
