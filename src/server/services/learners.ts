import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addLearnerSchema } from "@/lib/validation/academic";
import { createLearnerSchema, userStatusSchema } from "@/lib/validation/learner";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin, assertRole } from "../authz";
import { db, type DbTx } from "../db";

/** Fields safe to return for a learner (never the password hash). */
export const learnerSelect = {
  id: true,
  name: true,
  email: true,
  status: true,
  createdAt: true,
  batchMemberships: { select: { batch: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Create a learner identified by email. Learners get no permanent password: exam access comes
 * from assessment-specific credentials. Optionally adds the learner to a batch.
 */
export async function createLearner(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const parsed = createLearnerSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const { name, email, batchId } = parsed.data;

  try {
    return await db.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new ConflictError("A user with this email already exists.");
      }
      const learner = await tx.user.create({ data: { name, email, role: Role.LEARNER, passwordHash: null }, select: { id: true } });
      if (batchId) {
        await assertBatchExists(tx, batchId);
        await tx.batchMember.create({ data: { batchId, userId: learner.id } });
      }
      await recordAudit(
        { actorId: actor.id, action: AuditAction.LEARNER_CREATED, entityType: "User", entityId: learner.id, metadata: { email, batchId: batchId ?? null } },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: learner.id }, select: learnerSelect });
    });
  } catch (err) {
    // Two admins creating the same email at once: the unique index is the final arbiter.
    if (isUniqueViolation(err)) throw new ConflictError("A user with this email already exists.");
    throw err;
  }
}

async function assertBatchExists(tx: DbTx, batchId: string) {
  if (!(await tx.batch.findUnique({ where: { id: batchId }, select: { id: true } }))) throw new NotFoundError("Batch not found.");
}

/** A batch that can take new members: it exists, is active and its course is active. */
async function assertBatchOpen(tx: DbTx, batchId: string) {
  const batch = await tx.batch.findUnique({ where: { id: batchId }, select: { isActive: true, course: { select: { isActive: true } } } });
  if (!batch) throw new NotFoundError("Batch not found.");
  if (!batch.isActive) throw new ConflictError("This batch is inactive. Activate it before adding learners.");
  if (!batch.course.isActive) throw new ConflictError("This batch’s course is inactive. Activate the course before adding learners.");
}

export interface AddLearnerResult {
  learner: Prisma.UserGetPayload<{ select: typeof learnerSelect }>;
  /** false when an existing learner account (same email) was added to the batch instead. */
  created: boolean;
}

/**
 * Add a learner to a batch by name + email. If no account has this email, a LEARNER is created
 * (with no password — exam access uses assessment credentials). If a learner with this email
 * already exists, that same account is added to the batch; their stored name is kept. Rejected:
 * an email that belongs to a staff account, a disabled learner, and a learner already in the batch.
 */
export async function addLearner(actor: SessionUser, raw: unknown): Promise<AddLearnerResult> {
  assertAdmin(actor);
  const parsed = addLearnerSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const { name, email, batchId } = parsed.data;

  try {
    return await db.$transaction(async (tx) => {
      await assertBatchOpen(tx, batchId);
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true, role: true, status: true } });

      let learnerId: string;
      let created = false;
      if (!existing) {
        learnerId = (await tx.user.create({ data: { name, email, role: Role.LEARNER, passwordHash: null }, select: { id: true } })).id;
        created = true;
        await recordAudit({ actorId: actor.id, action: AuditAction.LEARNER_CREATED, entityType: "User", entityId: learnerId, metadata: { email, batchId } }, tx);
      } else {
        if (existing.role !== Role.LEARNER) throw new ConflictError("This email belongs to a staff account and can’t be added as a learner.");
        if (existing.status !== UserStatus.ACTIVE) throw new ConflictError("This learner’s account is disabled. Enable it before adding them to a batch.");
        if (await tx.batchMember.findUnique({ where: { batchId_userId: { batchId, userId: existing.id } }, select: { id: true } })) {
          throw new ConflictError("This learner is already in this batch.");
        }
        learnerId = existing.id;
      }

      await tx.batchMember.create({ data: { batchId, userId: learnerId } });
      await recordAudit({ actorId: actor.id, action: AuditAction.BATCH_MEMBERS_ADDED, entityType: "Batch", entityId: batchId, metadata: { added: 1, learnerId } }, tx);
      const learner = await tx.user.findUniqueOrThrow({ where: { id: learnerId }, select: learnerSelect });
      return { learner, created };
    });
  } catch (err) {
    // Concurrent add of the same email or membership: the unique indexes decide.
    if (isUniqueViolation(err)) throw new ConflictError("This learner is already in this batch.");
    throw err;
  }
}

export interface LearnerImportRow {
  /** Spreadsheet row number, used in error messages. */
  row: number;
  name: unknown;
  email: unknown;
}

export interface LearnerImportSummary {
  /** New learner accounts created. */
  created: number;
  /** Existing learner accounts added to the batch. */
  addedExisting: number;
  /** Learners who were already in the batch (left as they were). */
  alreadyInBatch: number;
}

/**
 * All-or-nothing import of learners into a batch, inside the caller's transaction. Every row is
 * checked with the same rules as `addLearner` (valid, normalised email; name; not a staff email;
 * not a disabled learner) and duplicates in the file are rejected. If any row is invalid nothing is
 * written. Learners already in the batch are skipped, so no membership is ever duplicated.
 */
export async function importLearnerRows(tx: DbTx, actorId: string, batchId: string, rows: LearnerImportRow[]): Promise<LearnerImportSummary> {
  if (rows.length === 0) throw new ValidationError("There are no learners to import.");
  const problems: string[] = [];
  const valid: { row: number; name: string; email: string }[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const parsed = addLearnerSchema.safeParse({ name: r.name, email: r.email, batchId });
    if (!parsed.success) {
      problems.push(`Row ${r.row}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    const first = seen.get(parsed.data.email);
    if (first) problems.push(`Row ${r.row}: ${parsed.data.email} also appears on row ${first}`);
    else seen.set(parsed.data.email, r.row);
    valid.push({ row: r.row, name: parsed.data.name, email: parsed.data.email });
  }

  await assertBatchOpen(tx, batchId);
  const existing = await tx.user.findMany({
    where: { email: { in: valid.map((v) => v.email) } },
    select: { id: true, email: true, role: true, status: true, batchMemberships: { where: { batchId }, select: { id: true } } },
  });
  const byEmail = new Map(existing.map((u) => [u.email, u]));
  for (const v of valid) {
    const u = byEmail.get(v.email);
    if (u && u.role !== Role.LEARNER) problems.push(`Row ${v.row}: ${v.email} belongs to a staff account`);
    else if (u && u.status !== UserStatus.ACTIVE) problems.push(`Row ${v.row}: ${v.email} is a disabled learner`);
  }
  if (problems.length) {
    throw new ValidationError(`${problems.length} row${problems.length === 1 ? "" : "s"} need fixing. Nothing was imported.`, { rows: problems });
  }

  const summary: LearnerImportSummary = { created: 0, addedExisting: 0, alreadyInBatch: 0 };
  const toAdd: string[] = [];
  for (const v of valid) {
    const u = byEmail.get(v.email);
    if (u?.batchMemberships.length) {
      summary.alreadyInBatch++;
      continue;
    }
    if (u) {
      summary.addedExisting++;
      toAdd.push(u.id);
      continue;
    }
    const created = await tx.user.create({ data: { name: v.name, email: v.email, role: Role.LEARNER, passwordHash: null }, select: { id: true } });
    await recordAudit({ actorId, action: AuditAction.LEARNER_CREATED, entityType: "User", entityId: created.id, metadata: { email: v.email, batchId } }, tx);
    summary.created++;
    toAdd.push(created.id);
  }
  if (toAdd.length) await tx.batchMember.createMany({ data: toAdd.map((userId) => ({ batchId, userId })), skipDuplicates: true });
  await recordAudit({ actorId, action: AuditAction.BATCH_MEMBERS_ADDED, entityType: "Batch", entityId: batchId, metadata: { ...summary, source: "import" } }, tx);
  return summary;
}

/** Import learners (name + email rows) into an existing batch, all-or-nothing. */
export async function importLearnersToBatch(actor: SessionUser, batchId: string, rows: LearnerImportRow[]) {
  assertAdmin(actor);
  try {
    return await db.$transaction((tx) => importLearnerRows(tx, actor.id, batchId, rows), { timeout: 60_000 });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Some of these learners were added at the same moment by someone else. Try the import again.");
    throw err;
  }
}

/**
 * Remove a learner from a batch. Only the membership is deleted: the account, assessment
 * candidacies, exam credentials and any later attempts/results are untouched.
 */
export async function removeLearnerFromBatch(actor: SessionUser, batchId: string, learnerId: string) {
  assertAdmin(actor);
  await db.$transaction(async (tx) => {
    await assertBatchExists(tx, batchId);
    const { count } = await tx.batchMember.deleteMany({ where: { batchId, userId: learnerId, user: { role: Role.LEARNER } } });
    if (count === 0) throw new NotFoundError("This learner isn’t in this batch.");
    await recordAudit({ actorId: actor.id, action: AuditAction.BATCH_MEMBER_REMOVED, entityType: "Batch", entityId: batchId, metadata: { learnerId } }, tx);
  });
}

/** A learner's details. Admins can read any learner; a learner can read only themselves. */
export async function getLearner(actor: SessionUser, learnerId: string) {
  assertRole(actor, Role.ADMIN, Role.LEARNER);
  if (actor.role === Role.LEARNER && actor.id !== learnerId) throw new ForbiddenError();
  const learner = await db.user.findFirst({ where: { id: learnerId, role: Role.LEARNER }, select: learnerSelect });
  if (!learner) throw new NotFoundError("Learner not found.");
  return learner;
}

/** Throws unless every id is an existing learner account. */
export async function assertLearners(tx: DbTx, learnerIds: string[]) {
  const unique = [...new Set(learnerIds)];
  const found = await tx.user.count({ where: { id: { in: unique }, role: Role.LEARNER } });
  if (found !== unique.length) throw new ValidationError("Only learner accounts can be added.");
  return unique;
}

/**
 * Add existing learners to a batch in bulk. Idempotent: learners already in the batch are skipped
 * and the number actually added is returned. Disabled learners are rejected.
 */
export async function addLearnersToBatch(actor: SessionUser, batchId: string, learnerIds: string[]) {
  assertAdmin(actor);
  if (learnerIds.length === 0) throw new ValidationError("Choose at least one learner.");
  return db.$transaction(async (tx) => {
    await assertBatchOpen(tx, batchId);
    const ids = await assertLearners(tx, learnerIds);
    if (await tx.user.count({ where: { id: { in: ids }, status: { not: UserStatus.ACTIVE } } })) {
      throw new ConflictError("Disabled learners can’t be added to a batch.");
    }
    const { count } = await tx.batchMember.createMany({ data: ids.map((userId) => ({ batchId, userId })), skipDuplicates: true });
    await recordAudit({ actorId: actor.id, action: AuditAction.BATCH_MEMBERS_ADDED, entityType: "Batch", entityId: batchId, metadata: { added: count } }, tx);
    return count;
  });
}

export async function listLearners(actor: SessionUser, filters: { batchId?: string; q?: string } = {}) {
  assertAdmin(actor);
  const q = filters.q?.trim();
  return db.user.findMany({
    where: {
      role: Role.LEARNER,
      ...(filters.batchId ? { batchMemberships: { some: { batchId: filters.batchId } } } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ name: "asc" }],
    take: 500,
    select: learnerSelect,
  });
}

/** Enable or disable a learner. Disabling ends their sessions immediately. */
export async function setLearnerStatus(actor: SessionUser, learnerId: string, rawStatus: unknown) {
  assertAdmin(actor);
  const status = userStatusSchema.parse(rawStatus);
  return db.$transaction(async (tx) => {
    const learner = await tx.user.findFirst({ where: { id: learnerId, role: Role.LEARNER }, select: { id: true, status: true } });
    if (!learner) throw new NotFoundError("Learner not found.");
    if (learner.status === status) return learner;
    const updated = await tx.user.update({ where: { id: learnerId }, data: { status }, select: { id: true, status: true } });
    if (status === UserStatus.DISABLED) await tx.session.deleteMany({ where: { userId: learnerId } });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.USER_STATUS_CHANGED, entityType: "User", entityId: learnerId, metadata: { from: learner.status, to: status } },
      tx,
    );
    return updated;
  });
}

/** Examiner accounts (for assignment pickers). */
export async function listExaminers(actor: SessionUser) {
  assertAdmin(actor);
  return db.user.findMany({
    where: { role: Role.EXAMINER },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, email: true, status: true },
  });
}
