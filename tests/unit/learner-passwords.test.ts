import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/*
 * Production bug: "Reset all passwords" for a batch failed with P2028 — the interactive transaction
 * ran up to two sequential queries per learner (user.update + session.deleteMany) and passed
 * Prisma's default 5 s limit over the network. These tests run the real service against an
 * in-memory database that records every query and applies writes only when the transaction
 * commits: a fixed number of statements whatever the batch size, bcrypt work before the transaction,
 * unique passwords, all-or-nothing writes, and the existing issuing/reset rules unchanged.
 */

type User = { id: string; name: string; email: string; role: string; passwordHash: string | null; updatedAt: Date };
type Tables = { users: User[]; sessions: { id: string; userId: string }[]; candidates: { assessmentId: string; learnerId: string }[]; assessments: { id: string }[]; audits: Record<string, unknown>[] };
const empty = (): Tables => ({ users: [], sessions: [], candidates: [], assessments: [], audits: [] });
const clone = (t: Tables): Tables => ({
  users: t.users.map((u) => ({ ...u })),
  sessions: t.sessions.map((s) => ({ ...s })),
  candidates: t.candidates.map((c) => ({ ...c })),
  assessments: t.assessments.map((a) => ({ ...a })),
  audits: t.audits.map((a) => ({ ...a })),
});

let committed: Tables = empty();
/** Every database call, in order; "tx:" marks calls inside a transaction. */
let calls: string[] = [];
let failOn: string | null = null;
let failWith: unknown = null;
/** Runs inside the transaction right before the UPDATE (simulates a concurrent change). */
let beforeUpdate: ((t: Tables) => void) | null = null;

function makeTx(t: Tables) {
  const op = (name: string) => {
    calls.push(`tx:${name}`);
    if (failOn === name) throw failWith;
  };
  return {
    /** UPDATE "users" … FROM (VALUES (id, hash, had_password), …): applied with the same WHERE rules. */
    $executeRaw: async (strings: TemplateStringsArray, ...args: { values: unknown[] }[]) => {
      op("$executeRaw");
      beforeUpdate?.(t);
      const sql = strings.join("?");
      expect(sql).toContain(`UPDATE "users"`);
      expect(sql).toContain(`u."role" = 'LEARNER'`);
      expect(sql).toContain(`(v.had_password OR u."passwordHash" IS NULL)`);
      const flat = args[0].values;
      let count = 0;
      for (let k = 0; k < flat.length; k += 3) {
        const [id, hash, hadPassword] = flat.slice(k, k + 3) as [string, string, boolean];
        const u = t.users.find((x) => x.id === id);
        if (u && u.role === "LEARNER" && (hadPassword || u.passwordHash === null)) {
          u.passwordHash = hash;
          count++;
        }
      }
      return count;
    },
    user: {
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { updatedAt: Date } }) => {
        op("user.updateMany");
        for (const u of t.users) if (where.id.in.includes(u.id)) u.updatedAt = data.updatedAt;
        return { count: where.id.in.length };
      },
    },
    session: {
      deleteMany: async ({ where }: { where: { userId: { in: string[] } } }) => {
        op("session.deleteMany");
        const before = t.sessions.length;
        t.sessions = t.sessions.filter((s) => !where.userId.in.includes(s.userId));
        return { count: before - t.sessions.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => (op("auditLog.create"), t.audits.push(data)) },
  };
}

const fakeDb = {
  assessment: { findUnique: async ({ where }: { where: { id: string } }) => (calls.push("assessment.findUnique"), committed.assessments.find((a) => a.id === where.id) ?? null) },
  assessmentCandidate: {
    findMany: async ({ where }: { where: { assessmentId: string } }) => {
      calls.push("assessmentCandidate.findMany");
      return committed.candidates.filter((c) => c.assessmentId === where.assessmentId).map((c) => ({ learner: { ...committed.users.find((u) => u.id === c.learnerId)! } }));
    },
  },
  user: { findUnique: async ({ where }: { where: { id: string } }) => (calls.push("user.findUnique"), committed.users.find((u) => u.id === where.id) ?? null) },
  /** Interactive transaction: works on a copy, committed only if the callback succeeds. */
  $transaction: async <T,>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
    calls.push("tx:begin");
    const draft = clone(committed);
    const result = await fn(makeTx(draft));
    committed = draft;
    calls.push("tx:commit");
    return result;
  },
};

/** Real bcrypt; cost 4 by default to keep 100-learner tests fast, the real cost 12 when asked. */
let realCost = false;
vi.mock("@/server/auth/password", async () => ({
  hashPassword: async (plain: string) => {
    calls.push("hash");
    return realCost ? (await vi.importActual<typeof import("@/server/auth/password")>("@/server/auth/password")).hashPassword(plain) : bcrypt.hash(plain, 4);
  },
}));
vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { issueLearnerPasswords, resetLearnerPassword, generateUniquePasswords } = await import("@/server/services/learner-passwords");
const { Prisma } = await import("@/generated/prisma/client");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");

const admin = { id: "admin-1", email: "admin@example.com", name: "Admin", role: "ADMIN" } as const;
const ASSESSMENT = "assess-1";
const OLD_HASH = "$2a$04$existingexistingexistingexistingexistingexistingexist";

/** n learners assigned to the assessment; `withPassword` of them already have one and a session. */
function seed(n: number, withPassword = 0) {
  committed = empty();
  committed.assessments.push({ id: ASSESSMENT });
  for (let i = 0; i < n; i++) {
    const id = `learner-${String(i).padStart(3, "0")}`;
    const has = i < withPassword;
    committed.users.push({ id, name: `Learner ${i}`, email: `l${i}@example.com`, role: "LEARNER", passwordHash: has ? OLD_HASH : null, updatedAt: new Date(0) });
    committed.candidates.push({ assessmentId: ASSESSMENT, learnerId: id });
    if (has) committed.sessions.push({ id: `s-${id}`, userId: id });
  }
}

const txCalls = () => calls.filter((c) => c.startsWith("tx:") && c !== "tx:begin" && c !== "tx:commit");

beforeEach(() => {
  committed = empty();
  calls = [];
  failOn = null;
  failWith = null;
  beforeUpdate = null;
  realCost = false;
});

describe("batch learner passwords: fixed number of statements, bcrypt outside the transaction", () => {
  it.each([1, 10, 50, 100])("reset for %i learner(s): every learner gets a new, unique, correctly hashed password", async (n) => {
    seed(n, n);
    const issued = await issueLearnerPasswords(admin, ASSESSMENT, { reset: true });

    expect(issued).toHaveLength(n);
    expect(new Set(issued.map((i) => i.password)).size).toBe(n);
    for (const i of issued) expect(i.password).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
    // Each learner's stored hash matches exactly their own password.
    for (const i of issued) {
      const row = committed.users.find((u) => u.id === i.learner.id)!;
      expect(row.passwordHash).not.toBe(OLD_HASH);
      expect(await bcrypt.compare(i.password, row.passwordHash!)).toBe(true);
      expect(row.updatedAt.getTime()).toBeGreaterThan(0);
    }
    if (n > 1) expect(await bcrypt.compare(issued[0].password, committed.users.find((u) => u.id === issued[1].learner.id)!.passwordHash!)).toBe(false);
    // Signed-out: every reset learner's sessions ended.
    expect(committed.sessions).toHaveLength(0);

    // All hashing before the transaction; inside it the same 4 statements whatever n is.
    expect(calls.lastIndexOf("hash")).toBeLessThan(calls.indexOf("tx:begin"));
    expect(calls.filter((c) => c === "hash")).toHaveLength(n);
    expect(txCalls()).toEqual(["tx:$executeRaw", "tx:user.updateMany", "tx:session.deleteMany", "tx:auditLog.create"]);
    expect(calls.filter((c) => c === "tx:begin")).toHaveLength(1);

    expect(committed.audits).toHaveLength(1);
    expect(committed.audits[0]).toMatchObject({ actorId: admin.id, action: "learner.password_issued", entityType: "User", metadata: { assessmentId: ASSESSMENT, reset: n, count: n } });
    expect(committed.audits[0].entityId).toBe(n === 1 ? issued[0].learner.id : undefined);
  });

  it("returns exactly the credentials the admin sees and hands out: name, email and that learner's password", async () => {
    seed(3, 0);
    const issued = await issueLearnerPasswords(admin, ASSESSMENT);
    expect(issued.map((i) => i.learner)).toEqual(committed.users.map((u) => ({ id: u.id, name: u.name, email: u.email })));
    for (const i of issued) expect(Object.keys(i).sort()).toEqual(["learner", "password"]);
    // No hash leaves the service.
    expect(JSON.stringify(issued)).not.toContain("$2");
  });

  it("stores a real bcrypt hash at cost 12 (the production setting)", async () => {
    realCost = true;
    seed(1, 0);
    const [i] = await issueLearnerPasswords(admin, ASSESSMENT);
    const hash = committed.users[0].passwordHash!;
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare(i.password, hash)).toBe(true);
    expect(await bcrypt.compare("WRONGPASS1", hash)).toBe(false);
  }, 30_000);

  it("generates the requested number of distinct passwords (a batch never shares one)", () => {
    const passwords = generateUniquePasswords(2000);
    expect(new Set(passwords).size).toBe(2000);
    for (const p of passwords) expect(p).toHaveLength(10);
  });
});

describe("existing issuing rules", () => {
  it("default issue: only learners without a password get one; existing passwords and sessions are untouched", async () => {
    seed(5, 2);
    const issued = await issueLearnerPasswords(admin, ASSESSMENT);
    expect(issued.map((i) => i.learner.id)).toEqual(["learner-002", "learner-003", "learner-004"]);
    expect(committed.users.slice(0, 2).map((u) => u.passwordHash)).toEqual([OLD_HASH, OLD_HASH]);
    expect(committed.sessions).toHaveLength(2);
    // A first password leaves sessions alone: no session delete at all.
    expect(txCalls()).toEqual(["tx:$executeRaw", "tx:user.updateMany", "tx:auditLog.create"]);
    expect(committed.audits[0].metadata).toEqual({ assessmentId: ASSESSMENT, reset: 0, count: 3 });
  });

  it("reset: sessions end only for learners who had a password; others keep theirs", async () => {
    seed(4, 2);
    committed.sessions.push({ id: "s-legacy", userId: "learner-003" }); // legacy exam-password session
    await issueLearnerPasswords(admin, ASSESSMENT, { reset: true });
    expect(committed.sessions).toEqual([{ id: "s-legacy", userId: "learner-003" }]);
    expect(committed.audits[0].metadata).toEqual({ assessmentId: ASSESSMENT, reset: 2, count: 4 });
  });

  it("nothing to issue: no hashing, no transaction", async () => {
    seed(3, 3);
    expect(await issueLearnerPasswords(admin, ASSESSMENT)).toEqual([]);
    expect(calls).not.toContain("hash");
    expect(calls).not.toContain("tx:begin");
  });

  it("only LEARNER candidates are issued passwords", async () => {
    seed(2, 0);
    committed.users[1].role = "ADMIN";
    const issued = await issueLearnerPasswords(admin, ASSESSMENT, { reset: true });
    expect(issued.map((i) => i.learner.id)).toEqual(["learner-000"]);
    expect(committed.users[1].passwordHash).toBeNull();
  });

  it("refuses an unknown assessment and one without candidates", async () => {
    seed(0);
    await expect(issueLearnerPasswords(admin, "missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(issueLearnerPasswords(admin, ASSESSMENT)).rejects.toBeInstanceOf(ValidationError);
  });

  it("single-learner reset still works (and refuses non-learners)", async () => {
    seed(2, 1);
    const r = await resetLearnerPassword(admin, "learner-000");
    expect(await bcrypt.compare(r.password, committed.users[0].passwordHash!)).toBe(true);
    expect(committed.users[1].passwordHash).toBeNull();
    expect(committed.sessions).toHaveLength(0);
    committed.users[1].role = "EXAMINER";
    await expect(resetLearnerPassword(admin, "learner-001")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("authorization", () => {
  it.each(["LEARNER", "EXAMINER", "REVIEWER"] as const)("a %s cannot issue or reset learner passwords; nothing is read or written", async (role) => {
    seed(3, 3);
    const before = clone(committed);
    const actor = { id: "x", email: "x@example.com", name: "X", role };
    await expect(issueLearnerPasswords(actor, ASSESSMENT, { reset: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resetLearnerPassword(actor, "learner-000")).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
    expect(committed).toEqual(before);
  });
});

describe("all-or-nothing", () => {
  it.each(["$executeRaw", "user.updateMany", "session.deleteMany", "auditLog.create"])("a database failure at %s rolls everything back: old passwords and sessions still valid", async (step) => {
    seed(50, 50);
    const before = clone(committed);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    failOn = step;
    failWith = new Prisma.PrismaClientKnownRequestError("Transaction API error: A query cannot be executed on an expired transaction.", { code: "P2028", clientVersion: "7" });
    const err = await issueLearnerPasswords(admin, ASSESSMENT, { reset: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("The passwords couldn’t be saved — nothing was changed and existing passwords still work. Please try again.");
    expect(committed).toEqual(before);
    expect(errors).toHaveBeenCalledWith("[learner passwords] database error", "P2028");
    errors.mockRestore();
  });

  it("a learner who changed after being read (got a password concurrently) aborts the whole batch", async () => {
    seed(10, 0);
    const before = clone(committed);
    beforeUpdate = (t) => (t.users[7].passwordHash = "$2a$04$concurrent");
    const err = await issueLearnerPasswords(admin, ASSESSMENT).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/nothing was changed/);
    expect(committed).toEqual(before);
  });

  it("a learner deleted or re-roled after being read aborts the whole batch", async () => {
    seed(10, 10);
    const before = clone(committed);
    beforeUpdate = (t) => (t.users[3].role = "ADMIN");
    await expect(issueLearnerPasswords(admin, ASSESSMENT, { reset: true })).rejects.toBeInstanceOf(ConflictError);
    expect(committed).toEqual(before);
  });

  it("an unexpected (non-database) error is rethrown unchanged and also rolls back", async () => {
    seed(5, 5);
    const before = clone(committed);
    failOn = "session.deleteMany";
    failWith = new Error("boom");
    await expect(issueLearnerPasswords(admin, ASSESSMENT, { reset: true })).rejects.toThrow("boom");
    expect(committed).toEqual(before);
  });
});

describe("generated passwords never reach logs or the audit trail", () => {
  it("no console output contains a password or a hash, on success or failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    seed(10, 10);
    const ok = await issueLearnerPasswords(admin, ASSESSMENT, { reset: true });
    failOn = "auditLog.create";
    failWith = new Prisma.PrismaClientKnownRequestError("db down", { code: "P1001", clientVersion: "7" });
    await issueLearnerPasswords(admin, ASSESSMENT, { reset: true }).catch(() => {});
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const i of ok) expect(logged).not.toContain(i.password);
    expect(logged).not.toContain("$2");
    expect(JSON.stringify(committed.audits)).not.toMatch(new RegExp(ok.map((i) => i.password).join("|")));
    expect(JSON.stringify(committed.audits)).not.toContain("$2");
    spies.forEach((s) => s.mockRestore());
  });
});
