import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createBatch, getBatch, listBatches, setBatchActive, updateBatch } from "@/server/services/batches";
import { assignExaminer, assignLearnersToAssessment, getCandidate, listCandidates } from "@/server/services/candidates";
import { createCourse, getCourse, listCourses, setCourseActive, updateCourse } from "@/server/services/courses";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { addLearner, addLearnersToBatch, getLearner, listLearners, removeLearnerFromBatch, setLearnerStatus } from "@/server/services/learners";
import { createActor, createAssessmentRow, createUser, resetDatabase } from "./helpers";

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

async function setup() {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse(admin, { code: "AIL", name: "AI for Leaders", description: "Leadership programme" });
  const batch = await createBatch(admin, { name: "AI Leaders - September 2026", courseId: course.id });
  return { admin, course, batch };
}

const expectError = (p: Promise<unknown>, type: new (...args: never[]) => Error) => expect(p).rejects.toBeInstanceOf(type);

// ---------------------------------------------------------------------------
describe("courses", () => {
  it("admin creates and retrieves a course (code normalised)", async () => {
    const admin = await createActor(Role.ADMIN);
    const created = await createCourse(admin, { code: " ds-101 ", name: "Data Science" });

    expect(created).toMatchObject({ code: "DS-101", name: "Data Science", description: null, isActive: true });
    await expect(getCourse(admin, created.id)).resolves.toMatchObject({ id: created.id, name: "Data Science", batches: [] });
    expect((await listCourses(admin)).map((c) => [c.name, c.batchCount])).toEqual([["Data Science", 0]]);
    expect(await db.auditLog.count({ where: { action: AuditAction.COURSE_CREATED } })).toBe(1);
  });

  it("admin updates a course; unchanged fields stay", async () => {
    const { admin, course } = await setup();
    const updated = await updateCourse(admin, course.id, { name: "AI for Senior Leaders" });
    expect(updated).toMatchObject({ code: "AIL", name: "AI for Senior Leaders", description: "Leadership programme" });
  });

  it("validates input and rejects duplicate codes and names (case-insensitive)", async () => {
    const { admin, course } = await setup();
    await expectError(createCourse(admin, { code: "PM" }), ValidationError);
    await expectError(createCourse(admin, { code: "P M!", name: "Product Management" }), ValidationError);
    await expectError(createCourse(admin, { code: "ail", name: "Another" }), ConflictError);
    await expectError(createCourse(admin, { code: "AIL2", name: "ai FOR leaders" }), ConflictError);
    const pm = await createCourse(admin, { code: "PM", name: "Product Management" });
    await expectError(updateCourse(admin, pm.id, { code: course.code }), ConflictError);
    await expectError(updateCourse(admin, "missing", { name: "X Y" }), NotFoundError);
  });

  it("activates and deactivates a course; an inactive course gets no new batches", async () => {
    const { admin, course } = await setup();
    await expect(setCourseActive(admin, course.id, false)).resolves.toMatchObject({ isActive: false });
    await expectError(createBatch(admin, { name: "AI Leaders - October 2026", courseId: course.id }), ValidationError);
    expect((await listCourses(admin, { activeOnly: true })).length).toBe(0);
    await expect(setCourseActive(admin, course.id, true)).resolves.toMatchObject({ isActive: true });
    await expectError(setCourseActive(admin, course.id, "yes"), ValidationError);
  });

  it("non-admins cannot create, update or deactivate courses", async () => {
    const { course } = await setup();
    for (const role of [Role.EXAMINER, Role.LEARNER, Role.REVIEWER]) {
      const actor = await createActor(role);
      await expectError(createCourse(actor, { code: "X1", name: "Xyz" }), ForbiddenError);
      await expectError(updateCourse(actor, course.id, { name: "Hacked" }), ForbiddenError);
      await expectError(setCourseActive(actor, course.id, false), ForbiddenError);
      await expectError(listCourses(actor), ForbiddenError);
    }
    await expect(db.course.findUniqueOrThrow({ where: { id: course.id } })).resolves.toMatchObject({ name: "AI for Leaders", isActive: true });
  });
});

// ---------------------------------------------------------------------------
describe("batches", () => {
  it("admin creates a batch that belongs to its course; no code required", async () => {
    const { admin, course, batch } = await setup();

    expect(batch).toMatchObject({ name: "AI Leaders - September 2026", code: null, isActive: true, course: { id: course.id, name: "AI for Leaders" } });
    await expect(getCourse(admin, course.id)).resolves.toMatchObject({ batches: [{ id: batch.id, learnerCount: 0 }] });
  });

  it("stores optional dates as IST days and validates their order", async () => {
    const { admin, course } = await setup();
    const b = await createBatch(admin, { name: "AI Leaders - Oct 2026", courseId: course.id, code: "ail-oct26", startDate: "2026-10-05", endDate: "2026-12-20" });
    expect(b.code).toBe("AIL-OCT26");
    expect(b.startDate?.toISOString()).toBe("2026-10-04T18:30:00.000Z");
    await expectError(createBatch(admin, { name: "Backwards", courseId: course.id, startDate: "2026-10-05", endDate: "2026-10-01" }), ValidationError);
    await expectError(updateBatch(admin, b.id, { endDate: "2026-09-01" }), ValidationError);
  });

  it("rejects a missing name, a missing/invalid course and duplicate names within a course", async () => {
    const { admin, course } = await setup();
    await expectError(createBatch(admin, { courseId: course.id }), ValidationError);
    await expectError(createBatch(admin, { name: "No course" }), ValidationError);
    await expectError(createBatch(admin, { name: "Ghost course", courseId: "does-not-exist" }), ValidationError);
    await expectError(createBatch(admin, { name: "ai leaders - september 2026", courseId: course.id }), ConflictError);
    // The same name in a different course is fine.
    const ds = await createCourse(admin, { code: "DS", name: "Data Science" });
    await expect(createBatch(admin, { name: "AI Leaders - September 2026", courseId: ds.id })).resolves.toMatchObject({ course: { id: ds.id } });
  });

  it("admin retrieves, lists and updates batches; the course can't be changed", async () => {
    const { admin, course, batch } = await setup();
    const other = await createCourse(admin, { code: "DS", name: "Data Science" });

    const updated = await updateBatch(admin, batch.id, { name: "AI Leaders - Sep 2026", code: "AIL-SEP26" });
    expect(updated).toMatchObject({ name: "AI Leaders - Sep 2026", code: "AIL-SEP26", course: { id: course.id } });
    await expectError(updateBatch(admin, batch.id, { courseId: other.id }), ValidationError);
    await expect(updateBatch(admin, batch.id, { courseId: course.id })).resolves.toMatchObject({ course: { id: course.id } });
    await expectError(updateBatch(admin, "missing", { name: "Whatever" }), NotFoundError);

    expect((await listBatches(admin, { courseId: course.id })).map((b) => b.name)).toEqual(["AI Leaders - Sep 2026"]);
    expect(await listBatches(admin, { courseId: other.id })).toEqual([]);
    await expect(getBatch(admin, batch.id)).resolves.toMatchObject({ id: batch.id, course: { name: "AI for Leaders" }, learners: [] });
  });

  it("activates and deactivates a batch", async () => {
    const { admin, batch } = await setup();
    await expect(setBatchActive(admin, batch.id, false)).resolves.toMatchObject({ isActive: false });
    expect(await listBatches(admin, { activeOnly: true })).toEqual([]);
    await expect(setBatchActive(admin, batch.id, true)).resolves.toMatchObject({ isActive: true });
  });

  it("non-admins cannot create, read or modify batches", async () => {
    const { course, batch } = await setup();
    for (const role of [Role.EXAMINER, Role.LEARNER, Role.REVIEWER]) {
      const actor = await createActor(role);
      await expectError(createBatch(actor, { name: "Sneaky batch", courseId: course.id }), ForbiddenError);
      await expectError(updateBatch(actor, batch.id, { name: "Renamed" }), ForbiddenError);
      await expectError(setBatchActive(actor, batch.id, false), ForbiddenError);
      await expectError(getBatch(actor, batch.id), ForbiddenError);
      await expectError(listBatches(actor), ForbiddenError);
    }
  });
});

// ---------------------------------------------------------------------------
describe("learners", () => {
  it("admin adds a new learner to a batch: LEARNER role, normalised email, no password", async () => {
    const { admin, batch } = await setup();

    const { learner, created } = await addLearner(admin, { name: "Rahul Sharma", email: " Rahul@Gmail.com ", batchId: batch.id });

    expect(created).toBe(true);
    expect(learner).toMatchObject({ name: "Rahul Sharma", email: "rahul@gmail.com", status: UserStatus.ACTIVE });
    expect(learner.batchMemberships.map((m) => m.batch.id)).toEqual([batch.id]);
    await expect(db.user.findUniqueOrThrow({ where: { id: learner.id } })).resolves.toMatchObject({ role: Role.LEARNER, passwordHash: null });
  });

  it("reuses an existing learner (same email) instead of creating a duplicate user", async () => {
    const { admin, course, batch } = await setup();
    const second = await createBatch(admin, { name: "AI Leaders - October 2026", courseId: course.id });
    const first = await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id });

    const again = await addLearner(admin, { name: "R. Sharma", email: "RAHUL@gmail.com", batchId: second.id });

    expect(again.created).toBe(false);
    expect(again.learner.id).toBe(first.learner.id);
    expect(again.learner.name).toBe("Rahul Sharma"); // stored name kept
    expect(again.learner.batchMemberships).toHaveLength(2);
    expect(await db.user.count({ where: { email: "rahul@gmail.com" } })).toBe(1);
  });

  it("rejects an invalid email, a missing batch, a nonexistent batch and a staff email", async () => {
    const { admin, batch } = await setup();
    await expectError(addLearner(admin, { name: "Rahul", email: "not-an-email", batchId: batch.id }), ValidationError);
    await expectError(addLearner(admin, { name: "Rahul", email: "rahul@gmail.com" }), ValidationError);
    await expectError(addLearner(admin, { name: "Rahul", email: "rahul@gmail.com", batchId: "missing" }), NotFoundError);
    await createUser({ email: "examiner1@example.com", role: Role.EXAMINER });
    await expectError(addLearner(admin, { name: "Examiner", email: "examiner1@example.com", batchId: batch.id }), ConflictError);
  });

  it("handles disabled learners: can't be added to a batch until re-enabled", async () => {
    const { admin, course, batch } = await setup();
    const other = await createBatch(admin, { name: "AI Leaders - October 2026", courseId: course.id });
    const { learner } = await addLearner(admin, { name: "Priya Shah", email: "priya@gmail.com", batchId: batch.id });
    await setLearnerStatus(admin, learner.id, UserStatus.DISABLED);

    await expectError(addLearner(admin, { name: "Priya Shah", email: "priya@gmail.com", batchId: other.id }), ConflictError);
    await expectError(addLearnersToBatch(admin, other.id, [learner.id]), ConflictError);
    // Still listed in the original batch, flagged as disabled.
    await expect(getBatch(admin, batch.id)).resolves.toMatchObject({ learners: [{ email: "priya@gmail.com", status: UserStatus.DISABLED }] });

    await setLearnerStatus(admin, learner.id, UserStatus.ACTIVE);
    await expect(addLearner(admin, { name: "Priya Shah", email: "priya@gmail.com", batchId: other.id })).resolves.toMatchObject({ created: false });
  });

  it("won't add learners to an inactive batch or a batch of an inactive course", async () => {
    const { admin, course, batch } = await setup();
    await setBatchActive(admin, batch.id, false);
    await expectError(addLearner(admin, { name: "Amit Rao", email: "amit@gmail.com", batchId: batch.id }), ConflictError);
    await setBatchActive(admin, batch.id, true);
    await setCourseActive(admin, course.id, false);
    await expectError(addLearner(admin, { name: "Amit Rao", email: "amit@gmail.com", batchId: batch.id }), ConflictError);
    expect(await db.user.count({ where: { email: "amit@gmail.com" } })).toBe(0);
  });

  it("a learner can read only their own details; examiners can't read learners", async () => {
    const { admin, batch } = await setup();
    const rahul = (await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id })).learner;
    const priya = (await addLearner(admin, { name: "Priya Shah", email: "priya@gmail.com", batchId: batch.id })).learner;
    const asRahul: SessionUser = { id: rahul.id, email: rahul.email, name: rahul.name, role: Role.LEARNER };

    await expect(getLearner(asRahul, rahul.id)).resolves.toMatchObject({ email: "rahul@gmail.com", batchMemberships: [{ batch: { id: batch.id } }] });
    await expectError(getLearner(asRahul, priya.id), ForbiddenError);
    await expectError(getLearner(await createActor(Role.EXAMINER), rahul.id), ForbiddenError);
    await expect(getLearner(admin, priya.id)).resolves.toMatchObject({ email: "priya@gmail.com" });
    await expectError(getLearner(admin, "missing"), NotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("batch membership", () => {
  it("batch details return the course and exactly its learners", async () => {
    const { admin, course, batch } = await setup();
    const other = await createBatch(admin, { name: "AI Leaders - October 2026", courseId: course.id });
    for (const [name, email] of [
      ["Rahul Sharma", "rahul@gmail.com"],
      ["Priya Shah", "priya@gmail.com"],
      ["Amit Rao", "amit@gmail.com"],
    ]) {
      await addLearner(admin, { name, email, batchId: batch.id });
    }
    await addLearner(admin, { name: "Neha Gupta", email: "neha@gmail.com", batchId: other.id });

    const details = await getBatch(admin, batch.id);

    expect(details.course).toMatchObject({ name: "AI for Leaders" });
    expect(details.learners.map((l) => `${l.name} — ${l.email}`)).toEqual(["Amit Rao — amit@gmail.com", "Priya Shah — priya@gmail.com", "Rahul Sharma — rahul@gmail.com"]);
    expect(details.learners[0]).not.toHaveProperty("passwordHash");
    expect((await listBatches(admin)).map((b) => [b.name, b.learnerCount]).sort()).toEqual([
      ["AI Leaders - October 2026", 1],
      ["AI Leaders - September 2026", 3],
    ]);
    expect((await listLearners(admin, { batchId: batch.id })).map((l) => l.email)).toEqual(["amit@gmail.com", "priya@gmail.com", "rahul@gmail.com"]);
  });

  it("rejects a duplicate single add; bulk add is idempotent", async () => {
    const { admin, batch } = await setup();
    const { learner } = await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id });

    await expectError(addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id }), ConflictError);
    await expect(addLearnersToBatch(admin, batch.id, [learner.id])).resolves.toBe(0);
    expect(await db.batchMember.count({ where: { batchId: batch.id } })).toBe(1);
    // The database itself refuses a second membership row.
    await expect(db.batchMember.create({ data: { batchId: batch.id, userId: learner.id } })).rejects.toThrow();
  });

  it("removes only the membership, never the learner or their assessment data", async () => {
    const { admin, course, batch } = await setup();
    const { learner } = await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id });
    const assessment = await createAssessmentRow({ courseId: course.id, createdById: admin.id });
    await assignLearnersToAssessment(admin, assessment.id, [learner.id]);
    await issueExamCredentials(admin, assessment.id);

    await removeLearnerFromBatch(admin, batch.id, learner.id);

    await expect(getBatch(admin, batch.id)).resolves.toMatchObject({ learners: [] });
    await expect(db.user.findUniqueOrThrow({ where: { id: learner.id } })).resolves.toMatchObject({ email: "rahul@gmail.com", status: UserStatus.ACTIVE });
    expect(await db.assessmentCandidate.count({ where: { learnerId: learner.id } })).toBe(1);
    expect(await db.examCredential.count({ where: { candidate: { learnerId: learner.id } } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: AuditAction.BATCH_MEMBER_REMOVED } })).toBe(1);
  });

  it("removing a learner who isn't in the batch, or from a missing batch, is not found", async () => {
    const { admin, batch } = await setup();
    const { learner } = await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id });
    await removeLearnerFromBatch(admin, batch.id, learner.id);
    await expectError(removeLearnerFromBatch(admin, batch.id, learner.id), NotFoundError);
    await expectError(removeLearnerFromBatch(admin, batch.id, "missing-learner"), NotFoundError);
    await expectError(removeLearnerFromBatch(admin, "missing-batch", learner.id), NotFoundError);
  });
});

// ---------------------------------------------------------------------------
describe("authorization", () => {
  it("examiners and learners cannot add, bulk-add, remove or list learners", async () => {
    const { admin, batch } = await setup();
    const { learner } = await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id });
    for (const role of [Role.EXAMINER, Role.LEARNER]) {
      const actor = await createActor(role);
      await expectError(addLearner(actor, { name: "Mallory", email: "mallory@gmail.com", batchId: batch.id }), ForbiddenError);
      await expectError(addLearnersToBatch(actor, batch.id, [learner.id]), ForbiddenError);
      await expectError(removeLearnerFromBatch(actor, batch.id, learner.id), ForbiddenError);
      await expectError(setLearnerStatus(actor, learner.id, UserStatus.DISABLED), ForbiddenError);
      await expectError(listLearners(actor), ForbiddenError);
    }
    expect(await db.batchMember.count({ where: { batchId: batch.id } })).toBe(1);
    expect(await db.user.count({ where: { email: "mallory@gmail.com" } })).toBe(0);
  });

  it("examiner access to learners stays limited to their assessment-specific assignments", async () => {
    const { admin, course, batch } = await setup();
    const rahul = (await addLearner(admin, { name: "Rahul Sharma", email: "rahul@gmail.com", batchId: batch.id })).learner;
    const priya = (await addLearner(admin, { name: "Priya Shah", email: "priya@gmail.com", batchId: batch.id })).learner;
    const assessment = await createAssessmentRow({ courseId: course.id, createdById: admin.id });
    await assignLearnersToAssessment(admin, assessment.id, [rahul.id, priya.id]);
    const candidates = await listCandidates(admin, assessment.id);
    const rahulCandidate = candidates.find((c) => c.learner.id === rahul.id)!;
    const priyaCandidate = candidates.find((c) => c.learner.id === priya.id)!;
    const examiner = await createActor(Role.EXAMINER);
    await assignExaminer(admin, assessment.id, [rahulCandidate.id], examiner.id);

    // Being in the same batch gives the examiner nothing; only the assignment does.
    expect((await listCandidates(examiner, assessment.id)).map((c) => c.learner.email)).toEqual(["rahul@gmail.com"]);
    await expectError(getCandidate(examiner, assessment.id, priyaCandidate.id), NotFoundError);
    await expectError(getBatch(examiner, batch.id), ForbiddenError);
  });
});
