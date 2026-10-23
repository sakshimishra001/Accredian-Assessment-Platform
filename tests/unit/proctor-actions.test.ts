import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Proctor dashboard, phase 3: manual lock and terminate. The real services run against an in-memory
 * stand-in for the database whose reads and conditional updates apply their where-clauses, so a
 * scoping or authorization mistake fails here. (Against PostgreSQL: tests/integration/proctor-actions.test.ts.)
 */

const NOW = new Date("2026-10-22T10:00:00Z");
type Role = "ADMIN" | "EXAMINER" | "REVIEWER" | "LEARNER";
const users = new Map<string, { id: string; role: Role; status: string; name: string; email: string }>();
const assessments = new Set<string>();
const proctors: { assessmentId: string; proctorId: string }[] = [];
type Attempt = { id: string; assessmentId: string; candidateId: string; learnerId: string; status: string; lockedAt: Date | null; terminatedAt?: Date; terminatedById?: string; terminationReason?: string };
const attempts = new Map<string, Attempt>();
const audits: Record<string, unknown>[] = [];

/** Plain-field equality, ignoring nested relation filters the stand-in doesn't model. */
const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v !== null && typeof v === "object" && !(v instanceof Date) ? true : row[k] === v));
const withLearner = (a: Attempt) => ({ ...a, learner: { name: users.get(a.learnerId)!.name } });

const fakeDb = {
  assessment: { count: async ({ where }: { where: { id: string } }) => (assessments.has(where.id) ? 1 : 0) },
  assessmentProctor: {
    count: async ({ where }: { where: { assessmentId: string; proctorId: string; proctor?: { status: string } } }) =>
      proctors.filter((p) => p.assessmentId === where.assessmentId && p.proctorId === where.proctorId && (!where.proctor || users.get(p.proctorId)?.status === where.proctor.status)).length,
  },
  assessmentAttempt: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const a = [...attempts.values()].find((x) => matches(x, where));
      return a ? withLearner(a) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const a = attempts.get(where.id);
      if (!a) throw new Error("not found");
      return a;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Attempt> }) => {
      const hits = [...attempts.values()].filter((x) => matches(x, where));
      for (const a of hits) Object.assign(a, data);
      return { count: hits.length };
    },
  },
  auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void audits.push(data) },
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.mock("@/server/services/attempts", async (importOriginal) => ({ ...(await importOriginal<object>()), closeExpiredAttempts: async () => 0 }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { lockAttempt } = await import("@/server/services/attempt-lock");
const { terminateAttempt, terminateAllActiveAttempts } = await import("@/server/services/attempt-termination");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");
const { monitoringBus } = await import("@/server/realtime/bus");

const actor = (id: string) => {
  const u = users.get(id)!;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
};
const REASON = "Repeatedly leaving the exam";

beforeEach(() => {
  users.clear();
  for (const [id, role] of [
    ["admin", "ADMIN"],
    ["pat", "REVIEWER"],
    ["quinn", "REVIEWER"],
    ["eve", "EXAMINER"],
    ["lina", "LEARNER"],
    ["mia", "LEARNER"],
  ] as const)
    users.set(id, { id, role, status: "ACTIVE", name: id[0].toUpperCase() + id.slice(1), email: `${id}@example.com` });
  assessments.clear();
  assessments.add("exam-A");
  assessments.add("exam-B");
  proctors.length = 0;
  proctors.push({ assessmentId: "exam-A", proctorId: "pat" });
  attempts.clear();
  attempts.set("att-lina", { id: "att-lina", assessmentId: "exam-A", candidateId: "cand-lina", learnerId: "lina", status: "IN_PROGRESS", lockedAt: null });
  attempts.set("att-mia", { id: "att-mia", assessmentId: "exam-B", candidateId: "cand-mia", learnerId: "mia", status: "IN_PROGRESS", lockedAt: null });
  audits.length = 0;
});

const lock = (who: string, attemptId = "att-lina", assessmentId = "exam-A", reason: unknown = REASON) => lockAttempt(actor(who), { assessmentId, attemptId, reason }, NOW);
const terminate = (who: string, attemptId = "att-lina", assessmentId = "exam-A", reason: unknown = REASON) => terminateAttempt(actor(who), { assessmentId, attemptId, reason }, NOW);

describe("lock", () => {
  it("an administrator can lock a running attempt: lockedAt is set and audited with actor, attempt and reason", async () => {
    expect(await lock("admin")).toMatchObject({ attemptId: "att-lina", learnerName: "Lina", lockedAt: NOW });
    expect(attempts.get("att-lina")).toMatchObject({ status: "IN_PROGRESS", lockedAt: NOW });
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: "admin",
        action: "attempt.locked",
        entityType: "AssessmentAttempt",
        entityId: "att-lina",
        metadata: expect.objectContaining({ assessmentId: "exam-A", reason: REASON, trigger: "manual", actorRole: "ADMIN", lockedAt: NOW.toISOString() }),
      }),
    ]);
  });

  it("an assigned proctor can lock a running attempt of their assessment", async () => {
    await lock("pat");
    expect(attempts.get("att-lina")!.lockedAt).toEqual(NOW);
    expect(audits[0]).toMatchObject({ actorId: "pat", metadata: expect.objectContaining({ actorRole: "REVIEWER" }) });
  });

  it("an unassigned proctor gets \"not found\"; examiners and learners are refused — nothing changes", async () => {
    await expect(lock("quinn")).rejects.toBeInstanceOf(NotFoundError);
    await expect(lock("eve")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(lock("lina")).rejects.toBeInstanceOf(ForbiddenError);
    expect(attempts.get("att-lina")!.lockedAt).toBeNull();
    expect(audits).toEqual([]);
  });

  it("an attempt of another assessment can't be locked through an assessment the proctor may see", async () => {
    await expect(lock("pat", "att-mia", "exam-A")).rejects.toBeInstanceOf(NotFoundError);
    await expect(lock("pat", "att-mia", "exam-B")).rejects.toBeInstanceOf(NotFoundError);
    await expect(lock("admin", "att-mia", "exam-A")).rejects.toBeInstanceOf(NotFoundError);
    expect(attempts.get("att-mia")!.lockedAt).toBeNull();
  });

  it("a locked attempt can't be locked again (one lock, one audit record)", async () => {
    await lock("pat");
    await expect(lock("admin")).rejects.toThrow(ConflictError);
    await expect(lock("admin")).rejects.toThrow(/already locked/);
    expect(attempts.get("att-lina")!.lockedAt).toEqual(NOW);
    expect(audits).toHaveLength(1);
  });

  it("only a running attempt can be locked", async () => {
    attempts.get("att-lina")!.status = "SUBMITTED";
    await expect(lock("admin")).rejects.toThrow(/already been submitted/);
    attempts.get("att-lina")!.status = "TERMINATED";
    await expect(lock("admin")).rejects.toThrow(/already been terminated/);
    expect(audits).toEqual([]);
  });

  it("a reason is required (empty or whitespace-only is refused)", async () => {
    for (const reason of ["", "   ", "ab", null]) await expect(lock("pat", "att-lina", "exam-A", reason)).rejects.toBeInstanceOf(ValidationError);
    await expect(lockAttempt(actor("pat"), { assessmentId: "exam-A", attemptId: "att-lina", reason: undefined }, NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(attempts.get("att-lina")!.lockedAt).toBeNull();
  });
});

describe("terminate", () => {
  it("an administrator can terminate: the existing termination with actor, reason and audit", async () => {
    expect(await terminate("admin")).toMatchObject({ attemptId: "att-lina", learnerName: "Lina" });
    expect(attempts.get("att-lina")).toMatchObject({ status: "TERMINATED", terminatedAt: NOW, terminatedById: "admin", terminationReason: REASON });
    expect(audits).toEqual([
      expect.objectContaining({ actorId: "admin", action: "attempt.terminated", entityId: "att-lina", metadata: expect.objectContaining({ assessmentId: "exam-A", reason: REASON, actorRole: "ADMIN" }) }),
    ]);
  });

  it("an assigned proctor can terminate an attempt of their assessment", async () => {
    await terminate("pat");
    expect(attempts.get("att-lina")).toMatchObject({ status: "TERMINATED", terminatedById: "pat" });
    expect(audits[0]).toMatchObject({ actorId: "pat", metadata: expect.objectContaining({ actorRole: "REVIEWER", reason: REASON }) });
  });

  it("an unassigned proctor gets \"not found\"; examiners and learners are refused — nothing changes", async () => {
    await expect(terminate("quinn")).rejects.toBeInstanceOf(NotFoundError);
    await expect(terminate("eve")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(terminate("lina")).rejects.toBeInstanceOf(ForbiddenError);
    expect(attempts.get("att-lina")!.status).toBe("IN_PROGRESS");
    expect(audits).toEqual([]);
  });

  it("an attempt of another assessment can't be terminated", async () => {
    await expect(terminate("pat", "att-mia", "exam-A")).rejects.toBeInstanceOf(NotFoundError);
    await expect(terminate("pat", "att-mia", "exam-B")).rejects.toBeInstanceOf(NotFoundError);
    expect(attempts.get("att-mia")!.status).toBe("IN_PROGRESS");
  });

  it("a reason is required; an attempt already ended can't be terminated again", async () => {
    for (const reason of ["", "   ", null]) await expect(terminate("pat", "att-lina", "exam-A", reason)).rejects.toBeInstanceOf(ValidationError);
    await expect(terminateAttempt(actor("pat"), { assessmentId: "exam-A", attemptId: "att-lina", reason: undefined }, NOW)).rejects.toBeInstanceOf(ValidationError);
    await terminate("pat");
    await expect(terminate("admin")).rejects.toThrow(/already been terminated/);
    expect(audits).toHaveLength(1);
  });

  it("a locked attempt can still be terminated", async () => {
    await lock("pat");
    await terminate("pat");
    expect(attempts.get("att-lina")!.status).toBe("TERMINATED");
  });

  it("terminating every running attempt at once stays administrator-only", async () => {
    await expect(terminateAllActiveAttempts(actor("pat"), { assessmentId: "exam-A", reason: REASON }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("live monitoring events (phase 5)", () => {
  function listen() {
    const got: string[] = [];
    const off = monitoringBus.subscribe("exam-A", (e) => got.push(`${e.type}:${e.attemptId}`));
    const offB = monitoringBus.subscribe("exam-B", (e) => got.push(`B:${e.type}:${e.attemptId}`));
    return { got, off: () => (off(), offB()) };
  }

  it("a successful lock publishes ATTEMPT_LOCKED; a refused or failed lock publishes nothing", async () => {
    const l = listen();
    await expect(lock("quinn")).rejects.toBeInstanceOf(NotFoundError);
    await expect(lock("pat", "att-lina", "exam-A", "")).rejects.toBeInstanceOf(ValidationError);
    expect(l.got).toEqual([]);
    await lock("pat");
    expect(l.got).toEqual(["ATTEMPT_LOCKED:att-lina"]);
    await expect(lock("admin")).rejects.toThrow(/already locked/); // no duplicate event
    expect(l.got).toEqual(["ATTEMPT_LOCKED:att-lina"]);
    l.off();
  });

  it("a successful termination publishes ATTEMPT_TERMINATED once; a repeat publishes nothing", async () => {
    const l = listen();
    await terminate("pat");
    await expect(terminate("admin")).rejects.toThrow(/already been terminated/);
    expect(l.got).toEqual(["ATTEMPT_TERMINATED:att-lina"]);
    l.off();
  });
});
