import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { createUser, resetDatabase } from "./helpers";

// --- Next.js request APIs: a cookie jar holding the signed-in user's session ----------------
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const actions = await import("@/server/actions/academic");

async function signInAs(role: Role, email = `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com`) {
  const user = await createUser({ role, email });
  // Learners need an exam credential for a valid session; for these tests a staff-style session
  // is enough to prove the role check (learner sessions without a credential are rejected anyway).
  const { token } = await createSession(user.id);
  jar.set(SESSION_COOKIE_NAME, token);
  return user;
}

beforeEach(async () => {
  jar.clear();
  revalidatePath.mockClear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const ok = <T,>(r: { ok: boolean; data?: T; error?: string }) => {
  if (!r.ok) throw new Error(`action failed: ${r.error}`);
  return r.data as T;
};

async function courseAndBatch() {
  const course = ok(await actions.createCourseAction({ code: "ail", name: "AI for Leaders" }));
  const batch = ok(await actions.createBatchAction({ name: "AI Leaders - September 2026", courseId: course.id }));
  return { courseId: course.id, batchId: batch.id };
}

// ---------------------------------------------------------------------------
describe("course actions", () => {
  beforeEach(() => signInAs(Role.ADMIN));

  it("creates a course in PostgreSQL and refreshes the pages", async () => {
    const { id } = ok(await actions.createCourseAction({ code: " ds-101 ", name: "Data Science", description: "Foundations" }));
    expect(await db.course.findUniqueOrThrow({ where: { id } })).toMatchObject({ code: "DS-101", name: "Data Science", description: "Foundations", isActive: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/courses");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/batches");
  });

  it("rejects duplicate codes and names with the service's field errors", async () => {
    await actions.createCourseAction({ code: "AIL", name: "AI for Leaders" });
    expect(await actions.createCourseAction({ code: "ail", name: "Other" })).toEqual({ ok: false, error: "A course with this code already exists." });
    expect(await actions.createCourseAction({ code: "AIL2", name: "ai for LEADERS" })).toEqual({ ok: false, error: "A course with this name already exists." });
    expect(await actions.createCourseAction({ code: "", name: "" })).toMatchObject({ ok: false, fieldErrors: { code: expect.any(Array), name: expect.any(Array) } });
    expect(await db.course.count()).toBe(1);
  });

  it("updates and activates/deactivates a course", async () => {
    const { id } = ok(await actions.createCourseAction({ code: "PM", name: "Product Management" }));
    ok(await actions.updateCourseAction(id, { name: "Product Management (2026)" }));
    ok(await actions.setCourseActiveAction(id, false));
    expect(await db.course.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Product Management (2026)", isActive: false });
    ok(await actions.setCourseActiveAction(id, true));
    expect((await db.course.findUniqueOrThrow({ where: { id } })).isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("batch actions", () => {
  beforeEach(() => signInAs(Role.ADMIN));

  it("creates a batch under its course", async () => {
    const { courseId, batchId } = await courseAndBatch();
    expect(await db.batch.findUniqueOrThrow({ where: { id: batchId } })).toMatchObject({ name: "AI Leaders - September 2026", courseId, code: null, isActive: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/batches/${batchId}`);
  });

  it("rejects a nonexistent or inactive course and a duplicate name in the course", async () => {
    const { courseId } = await courseAndBatch();
    expect(await actions.createBatchAction({ name: "Ghost", courseId: "missing" })).toMatchObject({ ok: false, fieldErrors: { courseId: ["Course not found"] } });
    expect(await actions.createBatchAction({ name: "ai leaders - september 2026", courseId })).toEqual({ ok: false, error: "This course already has a batch with this name." });
    await actions.setCourseActiveAction(courseId, false);
    expect(await actions.createBatchAction({ name: "Another batch", courseId })).toMatchObject({ ok: false, fieldErrors: { courseId: ["Course is inactive"] } });
    expect(await db.batch.count()).toBe(1);
  });

  it("updates a batch and toggles it active", async () => {
    const { batchId } = await courseAndBatch();
    ok(await actions.updateBatchAction(batchId, { name: "AI Leaders - Sep 2026", code: "ail-sep26", startDate: "2026-09-01", endDate: "2026-12-15" }));
    ok(await actions.setBatchActiveAction(batchId, false));
    const b = await db.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(b).toMatchObject({ name: "AI Leaders - Sep 2026", code: "AIL-SEP26", isActive: false });
    expect(b.startDate?.toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });

  it("creates a batch with its learners from a CSV — and creates nothing if a row is invalid", async () => {
    const { courseId } = await courseAndBatch();
    const csv = (body: string) => ({ fileName: "learners.csv", content: `name,email\n${body}` });

    const bad = await actions.createBatchAction({ name: "Batch with bad rows", courseId }, csv("Rahul Sharma,rahul@gmail.com\nPriya Shah,not-an-email"));
    expect(bad).toMatchObject({ ok: false, fieldErrors: { rows: ["Row 3: Enter a valid email address"] } });
    expect(await db.batch.count({ where: { name: "Batch with bad rows" } })).toBe(0);
    expect(await db.user.count({ where: { email: "rahul@gmail.com" } })).toBe(0);

    const good = ok(await actions.createBatchAction({ name: "Batch with learners", courseId }, csv("Rahul Sharma,Rahul@Gmail.com\nPriya Shah,priya@gmail.com")));
    expect(good.learners).toEqual({ created: 2, addedExisting: 0, alreadyInBatch: 0 });
    expect(await db.batchMember.count({ where: { batchId: good.id } })).toBe(2);
    expect(await actions.createBatchAction({ name: "Not a CSV", courseId }, { fileName: "learners.xlsx", content: "x" })).toMatchObject({ ok: false, fieldErrors: { csv: expect.any(Array) } });
  });
});

// ---------------------------------------------------------------------------
describe("learner actions", () => {
  beforeEach(() => signInAs(Role.ADMIN));

  it("adds a learner with a normalised email, LEARNER role and no password", async () => {
    const { batchId } = await courseAndBatch();
    expect(ok(await actions.addLearnerAction({ name: "Rahul Sharma", email: "  Rahul@Gmail.COM ", batchId }))).toEqual({ created: true, name: "Rahul Sharma" });
    const user = await db.user.findUniqueOrThrow({ where: { email: "rahul@gmail.com" }, include: { batchMemberships: true } });
    expect(user).toMatchObject({ role: Role.LEARNER, passwordHash: null, status: UserStatus.ACTIVE });
    expect(user.batchMemberships.map((m) => m.batchId)).toEqual([batchId]);
    expect(await db.examCredential.count()).toBe(0);
  });

  it("reports duplicate membership, staff emails and invalid input as action errors", async () => {
    const { batchId } = await courseAndBatch();
    await actions.addLearnerAction({ name: "Rahul Sharma", email: "rahul@gmail.com", batchId });
    expect(await actions.addLearnerAction({ name: "Rahul Sharma", email: "RAHUL@gmail.com", batchId })).toEqual({ ok: false, error: "This learner is already in this batch." });
    await createUser({ role: Role.EXAMINER, email: "examiner1@example.com" });
    expect(await actions.addLearnerAction({ name: "Examiner", email: "examiner1@example.com", batchId })).toMatchObject({ ok: false, error: expect.stringMatching(/staff account/) });
    expect(await actions.addLearnerAction({ name: "R", email: "nope", batchId })).toMatchObject({ ok: false, fieldErrors: { name: expect.any(Array), email: expect.any(Array) } });
  });

  it("lets a learner belong to several batches; removing from one keeps the other and the account", async () => {
    const { courseId, batchId: first } = await courseAndBatch();
    const second = ok(await actions.createBatchAction({ name: "AI Leaders - October 2026", courseId })).id;
    ok(await actions.addLearnerAction({ name: "Rahul Sharma", email: "rahul@gmail.com", batchId: first }));
    expect(ok(await actions.addLearnerAction({ name: "Rahul S.", email: "rahul@gmail.com", batchId: second }))).toEqual({ created: false, name: "Rahul Sharma" });
    const rahul = await db.user.findUniqueOrThrow({ where: { email: "rahul@gmail.com" } });
    expect(await db.batchMember.count({ where: { userId: rahul.id } })).toBe(2);

    ok(await actions.removeLearnerFromBatchAction(first, rahul.id));

    expect((await db.batchMember.findMany({ where: { userId: rahul.id } })).map((m) => m.batchId)).toEqual([second]);
    expect(await db.user.findUnique({ where: { id: rahul.id } })).not.toBeNull();
    expect(await actions.removeLearnerFromBatchAction(first, rahul.id)).toEqual({ ok: false, error: "This learner isn’t in this batch." });
  });

  it("disables and re-enables a learner globally (not just in one batch)", async () => {
    const { courseId, batchId } = await courseAndBatch();
    const other = ok(await actions.createBatchAction({ name: "AI Leaders - October 2026", courseId })).id;
    await actions.addLearnerAction({ name: "Priya Shah", email: "priya@gmail.com", batchId });
    await actions.addLearnerAction({ name: "Priya Shah", email: "priya@gmail.com", batchId: other });
    const priya = await db.user.findUniqueOrThrow({ where: { email: "priya@gmail.com" } });

    ok(await actions.setLearnerStatusAction(priya.id, "DISABLED", batchId));
    expect((await db.user.findUniqueOrThrow({ where: { id: priya.id } })).status).toBe(UserStatus.DISABLED);
    expect(await db.batchMember.count({ where: { userId: priya.id } })).toBe(2); // memberships untouched
    expect(await actions.addLearnerAction({ name: "Priya Shah", email: "priya@gmail.com", batchId: ok(await actions.createBatchAction({ name: "Third batch", courseId })).id })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/disabled/),
    });

    ok(await actions.setLearnerStatusAction(priya.id, "ACTIVE"));
    expect((await db.user.findUniqueOrThrow({ where: { id: priya.id } })).status).toBe(UserStatus.ACTIVE);
  });

  it("imports learners from a CSV into an existing batch, all-or-nothing", async () => {
    const { batchId } = await courseAndBatch();
    await actions.addLearnerAction({ name: "Rahul Sharma", email: "rahul@gmail.com", batchId });
    await createUser({ role: Role.EXAMINER, email: "staff@example.com" });
    const csv = (body: string) => ({ fileName: "learners.csv", content: `Name,Email,Phone\n${body}` });

    const bad = await actions.importLearnersAction(batchId, csv("Amit Rao,amit@gmail.com,\nStaff,staff@example.com,\nDup,amit@gmail.com,"));
    expect(bad).toMatchObject({ ok: false, fieldErrors: { rows: ["Row 4: amit@gmail.com also appears on row 2", "Row 3: staff@example.com belongs to a staff account"] } });
    expect(await db.user.count({ where: { email: "amit@gmail.com" } })).toBe(0);

    const good = ok(await actions.importLearnersAction(batchId, csv("Amit Rao,amit@gmail.com,99999\nRahul Sharma,rahul@gmail.com,")));
    expect(good).toEqual({ created: 1, addedExisting: 0, alreadyInBatch: 1 });
    expect(await db.batchMember.count({ where: { batchId } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("authorization", () => {
  it("anonymous calls are sent to /login and change nothing", async () => {
    await expect(actions.createCourseAction({ code: "X1", name: "Nope" })).rejects.toMatchObject({ url: "/login" });
    expect(await db.course.count()).toBe(0);
  });

  it.each([Role.EXAMINER, Role.REVIEWER, Role.LEARNER])("a %s can't use any course, batch or learner action", async (role) => {
    await signInAs(Role.ADMIN);
    const { courseId, batchId } = await courseAndBatch();
    await actions.addLearnerAction({ name: "Rahul Sharma", email: "rahul@gmail.com", batchId });
    const rahul = await db.user.findUniqueOrThrow({ where: { email: "rahul@gmail.com" } });
    jar.clear();
    await signInAs(role);

    // Staff roles are bounced to /forbidden; a learner session without an exam credential is no session at all (/login).
    const expected = role === Role.LEARNER ? "/login" : "/forbidden";
    for (const attempt of [
      () => actions.createCourseAction({ code: "HACK", name: "Hacked" }),
      () => actions.updateCourseAction(courseId, { name: "Hacked" }),
      () => actions.setCourseActiveAction(courseId, false),
      () => actions.createBatchAction({ name: "Hacked batch", courseId }),
      () => actions.updateBatchAction(batchId, { name: "Hacked" }),
      () => actions.setBatchActiveAction(batchId, false),
      () => actions.addLearnerAction({ name: "Mallory", email: "mallory@gmail.com", batchId }),
      () => actions.importLearnersAction(batchId, { fileName: "x.csv", content: "name,email\nM,m@gmail.com" }),
      () => actions.removeLearnerFromBatchAction(batchId, rahul.id),
      () => actions.setLearnerStatusAction(rahul.id, "DISABLED"),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ url: expected });
    }
    expect(await db.course.findUniqueOrThrow({ where: { id: courseId } })).toMatchObject({ name: "AI for Leaders", isActive: true });
    expect(await db.batchMember.count({ where: { batchId } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: rahul.id } })).status).toBe(UserStatus.ACTIVE);
    expect(await db.user.count({ where: { email: "mallory@gmail.com" } })).toBe(0);
  });
});
