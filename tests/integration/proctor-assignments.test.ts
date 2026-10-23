import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { db } from "@/server/db";
import { assertCanProctor, assignProctor, listAssessmentProctors, listProctorOptions, unassignProctor } from "@/server/services/proctor-assignments";
import { createAssessmentRow, createUser, resetDatabase } from "./helpers";

/* Proctor dashboard, phase 1: proctor assignment and assertCanProctor, against PostgreSQL. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const asActor = (u: { id: string; email: string; name: string; role: Role }) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

async function world() {
  const admin = asActor(await createUser({ role: Role.ADMIN }));
  const proctor = asActor(await createUser({ role: Role.REVIEWER, name: "Pat Proctor" }));
  const otherProctor = asActor(await createUser({ role: Role.REVIEWER, name: "Quinn Proctor" }));
  const examiner = asActor(await createUser({ role: Role.EXAMINER }));
  const learner = asActor(await createUser({ role: Role.LEARNER }));
  const a = await createAssessmentRow({ createdById: admin.id });
  const b = await createAssessmentRow({ createdById: admin.id });
  return { admin, proctor, otherProctor, examiner, learner, a, b };
}

describe("proctor assignment", () => {
  it("admin: any assessment; assigned proctor: only theirs; examiner and learner: never", async () => {
    const w = await world();
    await assignProctor(w.admin, w.a.id, w.proctor.id);
    await expect(assertCanProctor(w.admin, w.b.id)).resolves.toBeUndefined();
    await expect(assertCanProctor(w.admin, "no-such-assessment")).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCanProctor(w.proctor, w.a.id)).resolves.toBeUndefined();
    await expect(assertCanProctor(w.proctor, w.b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCanProctor(w.otherProctor, w.a.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertCanProctor(w.examiner, w.a.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertCanProctor(w.learner, w.a.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a duplicate is refused by the service and by the unique (assessment, proctor) constraint", async () => {
    const w = await world();
    await assignProctor(w.admin, w.a.id, w.proctor.id);
    await expect(assignProctor(w.admin, w.a.id, w.proctor.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(db.assessmentProctor.create({ data: { assessmentId: w.a.id, proctorId: w.proctor.id, assignedById: w.admin.id } })).rejects.toMatchObject({ code: "P2002" });
    expect(await db.assessmentProctor.count()).toBe(1);
  });

  it("removing an assignment removes access; both changes are audited with assessment and proctor", async () => {
    const w = await world();
    await assignProctor(w.admin, w.a.id, w.proctor.id);
    await unassignProctor(w.admin, w.a.id, w.proctor.id);
    await expect(assertCanProctor(w.proctor, w.a.id)).rejects.toBeInstanceOf(NotFoundError);
    const audits = await db.auditLog.findMany({ where: { entityId: w.a.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((x) => [x.action, x.metadata])).toEqual([
      ["assessment.proctor_assigned", { assessmentId: w.a.id, proctorId: w.proctor.id }],
      ["assessment.proctor_unassigned", { assessmentId: w.a.id, proctorId: w.proctor.id }],
    ]);
  });

  it("only active proctor accounts can be assigned, only by an administrator; lists show assigned and assignable proctors", async () => {
    const w = await world();
    await expect(assignProctor(w.admin, w.a.id, w.examiner.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(assignProctor(w.proctor, w.a.id, w.proctor.id)).rejects.toBeInstanceOf(ForbiddenError);
    await db.user.update({ where: { id: w.otherProctor.id }, data: { status: UserStatus.DISABLED } });
    await expect(assignProctor(w.admin, w.a.id, w.otherProctor.id)).rejects.toBeInstanceOf(ValidationError);
    await assignProctor(w.admin, w.a.id, w.proctor.id);
    expect((await listAssessmentProctors(w.admin, w.a.id)).map((p) => p.id)).toEqual([w.proctor.id]);
    expect((await listProctorOptions(w.admin)).map((p) => p.id)).toEqual([w.proctor.id]);
  });

  it("deleting an assessment or the proctor's account removes the assignment (cascade)", async () => {
    const w = await world();
    await assignProctor(w.admin, w.a.id, w.proctor.id);
    await assignProctor(w.admin, w.b.id, w.proctor.id);
    await db.assessment.delete({ where: { id: w.a.id } });
    expect(await db.assessmentProctor.count()).toBe(1);
    await db.user.delete({ where: { id: w.proctor.id } });
    expect(await db.assessmentProctor.count()).toBe(0);
  });
});
