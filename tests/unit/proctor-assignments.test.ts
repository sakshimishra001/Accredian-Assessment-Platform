import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Proctor dashboard, phase 1: proctors assigned to assessments, and assertCanProctor — the check
 * every proctor-facing service starts with. Runs the real service against an in-memory stand-in for
 * the database (no PostgreSQL needed); tests/integration/proctor-assignments.test.ts repeats the
 * essentials against PostgreSQL.
 */

type User = { id: string; name: string; email: string; role: "ADMIN" | "EXAMINER" | "REVIEWER" | "LEARNER"; status: "ACTIVE" | "DISABLED" };
type Row = { id: string; assessmentId: string; proctorId: string; assignedById: string; createdAt: Date };

const users = new Map<string, User>();
const assessments = new Map<string, { id: string; status: string }>();
const rows: Row[] = [];
const audits: Record<string, unknown>[] = [];
let failNextCreateWithDuplicate = false;

const fakeDb = {
  assessment: {
    count: async ({ where }: { where: { id: string } }) => (assessments.has(where.id) ? 1 : 0),
    findUnique: async ({ where }: { where: { id: string } }) => assessments.get(where.id) ?? null,
  },
  user: { findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null },
  assessmentProctor: {
    count: async ({ where }: { where: { assessmentId: string; proctorId: string; proctor?: { status: string } } }) =>
      rows.filter((r) => r.assessmentId === where.assessmentId && r.proctorId === where.proctorId && (!where.proctor || users.get(r.proctorId)?.status === where.proctor.status)).length,
    findUnique: async ({ where }: { where: { assessmentId_proctorId: { assessmentId: string; proctorId: string } } }) =>
      rows.find((r) => r.assessmentId === where.assessmentId_proctorId.assessmentId && r.proctorId === where.assessmentId_proctorId.proctorId) ?? null,
    create: async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
      if (failNextCreateWithDuplicate || rows.some((r) => r.assessmentId === data.assessmentId && r.proctorId === data.proctorId)) {
        failNextCreateWithDuplicate = false;
        const { Prisma } = await import("@/generated/prisma/client");
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const row = { ...data, id: `ap-${rows.length + 1}`, createdAt: new Date() };
      rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: { assessmentId: string; proctorId: string } }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].assessmentId === where.assessmentId && rows[i].proctorId === where.proctorId) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  },
  auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void audits.push(data) },
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { assertCanProctor, assignProctor, proctorAccess, unassignProctor } = await import("@/server/services/proctor-assignments");
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = await import("@/lib/errors");

const actor = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const admin: User = { id: "admin", name: "Ada Admin", email: "admin@example.com", role: "ADMIN", status: "ACTIVE" };
const proctor: User = { id: "pat", name: "Pat Proctor", email: "pat@example.com", role: "REVIEWER", status: "ACTIVE" };
const otherProctor: User = { id: "quinn", name: "Quinn Proctor", email: "quinn@example.com", role: "REVIEWER", status: "ACTIVE" };
const examiner: User = { id: "eve", name: "Eve Examiner", email: "eve@example.com", role: "EXAMINER", status: "ACTIVE" };
const learner: User = { id: "lina", name: "Lina Learner", email: "lina@example.com", role: "LEARNER", status: "ACTIVE" };

beforeEach(() => {
  users.clear();
  for (const u of [admin, proctor, otherProctor, examiner, learner]) users.set(u.id, { ...u });
  assessments.clear();
  assessments.set("exam-A", { id: "exam-A", status: "ACTIVE" });
  assessments.set("exam-B", { id: "exam-B", status: "SCHEDULED" });
  rows.length = 0;
  audits.length = 0;
  failNextCreateWithDuplicate = false;
});

describe("assertCanProctor", () => {
  it("an administrator may proctor any assessment (one that exists)", async () => {
    await expect(assertCanProctor(actor(admin), "exam-A")).resolves.toBeUndefined();
    await expect(assertCanProctor(actor(admin), "exam-B")).resolves.toBeUndefined();
    await expect(assertCanProctor(actor(admin), "no-such-exam")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an assigned proctor may access their assessment — and no other (which is \"not found\", whether it exists or not)", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    await expect(assertCanProctor(actor(proctor), "exam-A")).resolves.toBeUndefined();
    await expect(assertCanProctor(actor(proctor), "exam-B")).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCanProctor(actor(proctor), "no-such-exam")).rejects.toBeInstanceOf(NotFoundError);
    // Another proctor isn't assigned to A.
    await expect(assertCanProctor(actor(otherProctor), "exam-A")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an examiner can't proctor (even an assessment that has proctors); a learner is denied", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    await expect(assertCanProctor(actor(examiner), "exam-A")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertCanProctor(actor(learner), "exam-A")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertCanProctor(null, "exam-A")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a disabled proctor account loses access", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    users.get(proctor.id)!.status = "DISABLED";
    await expect(assertCanProctor(actor(proctor), "exam-A")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the role rules, on their own", () => {
    expect(proctorAccess("ADMIN", false)).toBe("allowed");
    expect(proctorAccess("REVIEWER", true)).toBe("allowed");
    expect(proctorAccess("REVIEWER", false)).toBe("not_found");
    expect(proctorAccess("EXAMINER", true)).toBe("forbidden");
    expect(proctorAccess("LEARNER", true)).toBe("forbidden");
  });
});

describe("assigning proctors", () => {
  it("assigns an existing proctor account, audited with the assessment and proctor", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    expect(rows).toEqual([expect.objectContaining({ assessmentId: "exam-A", proctorId: proctor.id, assignedById: admin.id })]);
    expect(audits).toEqual([expect.objectContaining({ action: "assessment.proctor_assigned", actorId: admin.id, entityId: "exam-A", metadata: { assessmentId: "exam-A", proctorId: proctor.id } })]);
  });

  it("several proctors per assessment; a proctor on several assessments", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    await assignProctor(actor(admin), "exam-A", otherProctor.id);
    await assignProctor(actor(admin), "exam-B", proctor.id);
    expect(rows).toHaveLength(3);
    await expect(assertCanProctor(actor(otherProctor), "exam-A")).resolves.toBeUndefined();
    await expect(assertCanProctor(actor(proctor), "exam-B")).resolves.toBeUndefined();
  });

  it("a duplicate assignment is refused — including two at once (the unique pair decides)", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    await expect(assignProctor(actor(admin), "exam-A", proctor.id)).rejects.toBeInstanceOf(ConflictError);
    failNextCreateWithDuplicate = true;
    await expect(assignProctor(actor(admin), "exam-B", proctor.id)).rejects.toBeInstanceOf(ConflictError);
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("only proctor accounts that are active can be assigned; staff accounts aren't created here", async () => {
    await expect(assignProctor(actor(admin), "exam-A", examiner.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(assignProctor(actor(admin), "exam-A", learner.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(assignProctor(actor(admin), "exam-A", "no-such-user")).rejects.toBeInstanceOf(ValidationError);
    users.get(proctor.id)!.status = "DISABLED";
    await expect(assignProctor(actor(admin), "exam-A", proctor.id)).rejects.toBeInstanceOf(ValidationError);
    expect(rows).toHaveLength(0);
  });

  it("only an administrator assigns or removes proctors", async () => {
    for (const u of [proctor, examiner, learner]) {
      await expect(assignProctor(actor(u), "exam-A", proctor.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(unassignProctor(actor(u), "exam-A", proctor.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("an unknown assessment is \"not found\"; an archived one can't be changed", async () => {
    await expect(assignProctor(actor(admin), "no-such-exam", proctor.id)).rejects.toBeInstanceOf(NotFoundError);
    assessments.set("exam-old", { id: "exam-old", status: "ARCHIVED" });
    await expect(assignProctor(actor(admin), "exam-old", proctor.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("removing proctors", () => {
  it("removing an assignment removes access immediately, audited; other assignments are kept", async () => {
    await assignProctor(actor(admin), "exam-A", proctor.id);
    await assignProctor(actor(admin), "exam-B", proctor.id);
    await unassignProctor(actor(admin), "exam-A", proctor.id);
    await expect(assertCanProctor(actor(proctor), "exam-A")).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCanProctor(actor(proctor), "exam-B")).resolves.toBeUndefined();
    expect(audits.at(-1)).toMatchObject({ action: "assessment.proctor_unassigned", entityId: "exam-A", metadata: { assessmentId: "exam-A", proctorId: proctor.id } });
  });

  it("removing a proctor who isn't assigned is \"not found\" and changes nothing", async () => {
    await expect(unassignProctor(actor(admin), "exam-A", proctor.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(audits).toHaveLength(0);
  });
});
