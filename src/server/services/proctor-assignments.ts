import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";

/*
 * Proctors assigned to assessments (proctor dashboard, phase 1). A proctor is a staff user with the
 * REVIEWER role (shown as "Proctor"). An administrator assigns proctors to an assessment; a proctor
 * may then access that assessment — and no other. Every proctor-facing service starts with
 * assertCanProctor.
 */

/** Who may proctor an assessment: decided from the actor's role and whether they are assigned. */
export function proctorAccess(role: SessionUser["role"], assigned: boolean): "allowed" | "not_found" | "forbidden" {
  if (role === Role.ADMIN) return "allowed";
  if (role === Role.REVIEWER) return assigned ? "allowed" : "not_found";
  // Examiners and learners never proctor (an examiner would need a separate REVIEWER account).
  return "forbidden";
}

/**
 * The actor may proctor this assessment: an administrator (any assessment), or a proctor assigned
 * to it. For a proctor, an assessment they aren't assigned to — or that doesn't exist — is "not
 * found", so its existence isn't revealed; other roles are refused outright.
 */
export async function assertCanProctor(actor: SessionUser | null | undefined, assessmentId: string, client: DbTx = db): Promise<void> {
  if (!actor) throw new ForbiddenError();
  if (actor.role !== Role.ADMIN && actor.role !== Role.REVIEWER) throw new ForbiddenError();
  if (typeof assessmentId !== "string" || !assessmentId) throw new NotFoundError("Assessment not found.");
  if (actor.role === Role.ADMIN) {
    // Any assessment — as long as it exists.
    if (!(await client.assessment.count({ where: { id: assessmentId } }))) throw new NotFoundError("Assessment not found.");
    return;
  }
  const assigned = (await client.assessmentProctor.count({ where: { assessmentId, proctorId: actor.id, proctor: { status: UserStatus.ACTIVE } } })) > 0;
  if (proctorAccess(actor.role, assigned) !== "allowed") throw new NotFoundError("Assessment not found.");
}

/** Assignments can change until the assessment is archived (like examiner assignment). */
async function loadAssignableAssessment(tx: DbTx, assessmentId: string) {
  const a = await tx.assessment.findUnique({ where: { id: assessmentId }, select: { id: true, status: true } });
  if (!a) throw new NotFoundError("Assessment not found.");
  if (a.status === AssessmentStatus.ARCHIVED) throw new ConflictError("Archived assessments can’t be changed.");
  return a;
}

/** Assign an existing, active proctor (REVIEWER) to an assessment. Assigning the same proctor twice is refused. */
export async function assignProctor(actor: SessionUser, assessmentId: string, proctorId: string) {
  assertAdmin(actor);
  if (typeof proctorId !== "string" || !proctorId) throw new ValidationError("Choose a proctor.", { proctorId: ["Choose a proctor"] });
  try {
    return await db.$transaction(async (tx) => {
      await loadAssignableAssessment(tx, assessmentId);
      const proctor = await tx.user.findUnique({ where: { id: proctorId }, select: { id: true, name: true, role: true, status: true } });
      if (!proctor || proctor.role !== Role.REVIEWER) throw new ValidationError("Choose a proctor account.", { proctorId: ["Choose a proctor account"] });
      if (proctor.status !== UserStatus.ACTIVE) throw new ValidationError("This proctor account is disabled.", { proctorId: ["This account is disabled"] });
      const existing = await tx.assessmentProctor.findUnique({ where: { assessmentId_proctorId: { assessmentId, proctorId } }, select: { id: true } });
      if (existing) throw new ConflictError(`${proctor.name} is already a proctor of this assessment.`);
      const row = await tx.assessmentProctor.create({ data: { assessmentId, proctorId, assignedById: actor.id }, select: { id: true, createdAt: true } });
      await recordAudit({ actorId: actor.id, action: AuditAction.PROCTOR_ASSIGNED, entityType: "Assessment", entityId: assessmentId, metadata: { assessmentId, proctorId } }, tx);
      return row;
    });
  } catch (err) {
    // Two admins assigning the same proctor at once: the unique (assessment, proctor) pair decides.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ConflictError("This proctor is already assigned to this assessment.");
    throw err;
  }
}

/** Remove a proctor from an assessment: their access to it ends immediately. */
export async function unassignProctor(actor: SessionUser, assessmentId: string, proctorId: string) {
  assertAdmin(actor);
  await db.$transaction(async (tx) => {
    await loadAssignableAssessment(tx, assessmentId);
    const { count } = await tx.assessmentProctor.deleteMany({ where: { assessmentId, proctorId } });
    if (count === 0) throw new NotFoundError("This proctor isn’t assigned to this assessment.");
    await recordAudit({ actorId: actor.id, action: AuditAction.PROCTOR_UNASSIGNED, entityType: "Assessment", entityId: assessmentId, metadata: { assessmentId, proctorId } }, tx);
  });
}

/** The proctors assigned to an assessment (admin view). */
export async function listAssessmentProctors(actor: SessionUser, assessmentId: string) {
  assertAdmin(actor);
  const rows = await db.assessmentProctor.findMany({
    where: { assessmentId },
    orderBy: { proctor: { name: "asc" } },
    select: { createdAt: true, proctor: { select: { id: true, name: true, email: true, status: true } }, assignedBy: { select: { name: true } } },
  });
  return rows.map((r) => ({ ...r.proctor, assignedAt: r.createdAt, assignedBy: r.assignedBy.name }));
}

/** Active proctor accounts that can be assigned (existing staff users only). */
export async function listProctorOptions(actor: SessionUser) {
  assertAdmin(actor);
  return db.user.findMany({ where: { role: Role.REVIEWER, status: UserStatus.ACTIVE }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } });
}
