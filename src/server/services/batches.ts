import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { activeFlagSchema, createBatchSchema, updateBatchSchema } from "@/lib/validation/academic";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { importLearnerRows, type LearnerImportRow } from "./learners";

const batchSelect = {
  id: true,
  code: true,
  name: true,
  startDate: true,
  endDate: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  course: { select: { id: true, code: true, name: true, isActive: true } },
} satisfies Prisma.BatchSelect;

function uniqueTarget(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return null;
  return JSON.stringify(err.meta ?? {});
}

function rethrowUnique(err: unknown): never {
  const target = uniqueTarget(err);
  if (target !== null) {
    throw new ConflictError(target.includes("code") ? "A batch with this code already exists." : "This course already has a batch with this name.");
  }
  throw err;
}

/** Batch names are unique within a course (case-insensitive); codes are unique overall. */
async function assertBatchUnique(tx: DbTx, courseId: string, values: { name?: string; code?: string | null }, exceptId?: string) {
  const not = exceptId ? { id: { not: exceptId } } : {};
  if (values.name && (await tx.batch.count({ where: { courseId, name: { equals: values.name, mode: "insensitive" }, ...not } }))) {
    throw new ConflictError("This course already has a batch with this name.");
  }
  if (values.code && (await tx.batch.count({ where: { code: values.code, ...not } }))) {
    throw new ConflictError("A batch with this code already exists.");
  }
}

type BatchInput = ReturnType<typeof createBatchSchema.parse>;

/** Create a batch inside an existing transaction (shared by createBatch and createBatchWithLearners). */
async function insertBatch(tx: DbTx, actorId: string, v: BatchInput) {
  const course = await tx.course.findUnique({ where: { id: v.courseId }, select: { isActive: true } });
  if (!course) throw new ValidationError("Choose a valid course.", { courseId: ["Course not found"] });
  if (!course.isActive) throw new ValidationError("This course is inactive. Activate it before adding batches.", { courseId: ["Course is inactive"] });
  await assertBatchUnique(tx, v.courseId, v);
  const batch = await tx.batch.create({
    data: { name: v.name, code: v.code ?? null, courseId: v.courseId, startDate: v.startDate ?? null, endDate: v.endDate ?? null },
    select: batchSelect,
  });
  await recordAudit({ actorId, action: AuditAction.BATCH_CREATED, entityType: "Batch", entityId: batch.id, metadata: { name: batch.name, courseId: v.courseId } }, tx);
  return batch;
}

function parseBatch(raw: unknown): BatchInput {
  const parsed = createBatchSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

export async function createBatch(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const v = parseBatch(raw);
  try {
    return await db.$transaction((tx) => insertBatch(tx, actor.id, v));
  } catch (err) {
    rethrowUnique(err);
  }
}

/**
 * Create a batch and import its learners in one transaction: if any learner row is invalid, the
 * batch isn't created either.
 */
export async function createBatchWithLearners(actor: SessionUser, raw: unknown, rows: LearnerImportRow[]) {
  assertAdmin(actor);
  const v = parseBatch(raw);
  try {
    return await db.$transaction(
      async (tx) => {
        const batch = await insertBatch(tx, actor.id, v);
        const learners = await importLearnerRows(tx, actor.id, batch.id, rows);
        return { batch, learners };
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    rethrowUnique(err);
  }
}

export async function listBatches(actor: SessionUser, filters: { courseId?: string; activeOnly?: boolean; q?: string } = {}) {
  assertAdmin(actor);
  const q = filters.q?.trim();
  const rows = await db.batch.findMany({
    where: {
      ...(filters.courseId ? { courseId: filters.courseId } : {}),
      ...(filters.activeOnly ? { isActive: true } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    select: { ...batchSelect, _count: { select: { members: true } } },
  });
  return rows.map(({ _count, ...b }) => ({ ...b, learnerCount: _count.members }));
}

/**
 * Batch → course → learners. The learner list is what the assessment module will use to pick a
 * batch's candidates. Learners are returned with their status so disabled ones can be shown/skipped.
 */
export async function getBatch(actor: SessionUser, id: string) {
  assertAdmin(actor);
  const batch = await db.batch.findUnique({
    where: { id },
    select: {
      ...batchSelect,
      members: {
        where: { user: { role: Role.LEARNER } },
        orderBy: { user: { name: "asc" } },
        select: { createdAt: true, user: { select: { id: true, name: true, email: true, status: true } } },
      },
    },
  });
  if (!batch) throw new NotFoundError("Batch not found.");
  const { members, ...rest } = batch;
  return { ...rest, learners: members.map((m) => ({ ...m.user, addedAt: m.createdAt })) };
}

/** Update name, code and dates. A batch can't be moved to another course. */
export async function updateBatch(actor: SessionUser, id: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = updateBatchSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const { courseId, ...v } = parsed.data;
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.batch.findUnique({ where: { id }, select: { courseId: true, startDate: true, endDate: true } });
      if (!current) throw new NotFoundError("Batch not found.");
      if (courseId !== undefined && courseId !== current.courseId) {
        throw new ValidationError("A batch can’t be moved to another course. Create a new batch instead.", { courseId: ["Can’t be changed"] });
      }
      const startDate = v.startDate === undefined ? current.startDate : v.startDate;
      const endDate = v.endDate === undefined ? current.endDate : v.endDate;
      if (startDate && endDate && endDate < startDate) {
        throw new ValidationError("End date must be on or after the start date", { endDate: ["End date must be on or after the start date"] });
      }
      await assertBatchUnique(tx, current.courseId, v, id);
      const batch = await tx.batch.update({ where: { id }, data: v, select: batchSelect });
      await recordAudit({ actorId: actor.id, action: AuditAction.BATCH_UPDATED, entityType: "Batch", entityId: id, metadata: { fields: Object.keys(v) } }, tx);
      return batch;
    });
  } catch (err) {
    rethrowUnique(err);
  }
}

/** Activate or deactivate a batch. Inactive batches keep their members but can't gain new ones. */
export async function setBatchActive(actor: SessionUser, id: string, rawActive: unknown) {
  assertAdmin(actor);
  const parsed = activeFlagSchema.safeParse(rawActive);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db.$transaction(async (tx) => {
    const batch = await tx.batch.findUnique({ where: { id }, select: { isActive: true } });
    if (!batch) throw new NotFoundError("Batch not found.");
    if (batch.isActive === parsed.data) return tx.batch.findUniqueOrThrow({ where: { id }, select: batchSelect });
    const updated = await tx.batch.update({ where: { id }, data: { isActive: parsed.data }, select: batchSelect });
    await recordAudit({ actorId: actor.id, action: AuditAction.BATCH_UPDATED, entityType: "Batch", entityId: id, metadata: { isActive: parsed.data } }, tx);
    return updated;
  });
}
