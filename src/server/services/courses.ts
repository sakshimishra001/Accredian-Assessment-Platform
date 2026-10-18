import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { activeFlagSchema, createCourseSchema, updateCourseSchema } from "@/lib/validation/academic";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";

const courseSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CourseSelect;

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Codes are unique (database); names are kept unique case-insensitively here. */
async function assertCourseUnique(tx: DbTx, values: { code?: string; name?: string }, exceptId?: string) {
  const not = exceptId ? { id: { not: exceptId } } : {};
  if (values.code && (await tx.course.count({ where: { code: values.code, ...not } }))) {
    throw new ConflictError("A course with this code already exists.");
  }
  if (values.name && (await tx.course.count({ where: { name: { equals: values.name, mode: "insensitive" }, ...not } }))) {
    throw new ConflictError("A course with this name already exists.");
  }
}

export async function createCourse(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const parsed = createCourseSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  try {
    return await db.$transaction(async (tx) => {
      await assertCourseUnique(tx, parsed.data);
      const course = await tx.course.create({ data: parsed.data, select: courseSelect });
      await recordAudit(
        { actorId: actor.id, action: AuditAction.COURSE_CREATED, entityType: "Course", entityId: course.id, metadata: { code: course.code, name: course.name } },
        tx,
      );
      return course;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("A course with this code already exists.");
    throw err;
  }
}

/** Courses with batch and learner counts. Inactive courses are included unless `activeOnly`. */
export async function listCourses(actor: SessionUser, filters: { activeOnly?: boolean } = {}) {
  assertAdmin(actor);
  const rows = await db.course.findMany({
    where: filters.activeOnly ? { isActive: true } : {},
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { ...courseSelect, _count: { select: { batches: true } } },
  });
  return rows.map(({ _count, ...c }) => ({ ...c, batchCount: _count.batches }));
}

/** One course with its batches (and each batch's learner count). */
export async function getCourse(actor: SessionUser, id: string) {
  assertAdmin(actor);
  const course = await db.course.findUnique({
    where: { id },
    select: {
      ...courseSelect,
      batches: {
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        select: { id: true, code: true, name: true, startDate: true, endDate: true, isActive: true, _count: { select: { members: true } } },
      },
    },
  });
  if (!course) throw new NotFoundError("Course not found.");
  return { ...course, batches: course.batches.map(({ _count, ...b }) => ({ ...b, learnerCount: _count.members })) };
}

/** Update code, name and/or description. Fields omitted are left unchanged. */
export async function updateCourse(actor: SessionUser, id: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = updateCourseSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  try {
    return await db.$transaction(async (tx) => {
      if (!(await tx.course.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError("Course not found.");
      await assertCourseUnique(tx, parsed.data, id);
      const course = await tx.course.update({ where: { id }, data: parsed.data, select: courseSelect });
      await recordAudit(
        { actorId: actor.id, action: AuditAction.COURSE_UPDATED, entityType: "Course", entityId: id, metadata: { fields: Object.keys(parsed.data) } },
        tx,
      );
      return course;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("A course with this code already exists.");
    throw err;
  }
}

/**
 * Activate or deactivate a course. Inactive courses can't get new batches or assessments;
 * existing batches, members and assessments are left untouched.
 */
export async function setCourseActive(actor: SessionUser, id: string, rawActive: unknown) {
  assertAdmin(actor);
  const parsed = activeFlagSchema.safeParse(rawActive);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db.$transaction(async (tx) => {
    const course = await tx.course.findUnique({ where: { id }, select: { isActive: true } });
    if (!course) throw new NotFoundError("Course not found.");
    if (course.isActive === parsed.data) return tx.course.findUniqueOrThrow({ where: { id }, select: courseSelect });
    const updated = await tx.course.update({ where: { id }, data: { isActive: parsed.data }, select: courseSelect });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.COURSE_UPDATED, entityType: "Course", entityId: id, metadata: { isActive: parsed.data } },
      tx,
    );
    return updated;
  });
}
