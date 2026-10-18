import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { AssessmentStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin, assertRole } from "../authz";
import { db, type DbTx } from "../db";
import { assertLearners } from "./learners";

/** Candidates can be added or removed until the assessment has ended. */
const CANDIDATE_EDITABLE: readonly AssessmentStatus[] = [AssessmentStatus.DRAFT, AssessmentStatus.SCHEDULED, AssessmentStatus.ACTIVE, AssessmentStatus.PAUSED];

// ---------------------------------------------------------------------------
// Authorization: which candidate rows an actor may see
// ---------------------------------------------------------------------------

/**
 * Row-level scope for candidate reads, applied inside every query (never by filtering results):
 * - ADMIN: every candidate.
 * - EXAMINER: only candidates assigned to them, in the assessment they were assigned for.
 * - LEARNER: only their own candidate rows (callers name the assessment explicitly).
 * - REVIEWER: none.
 */
export function candidateScope(actor: SessionUser): Prisma.AssessmentCandidateWhereInput {
  assertRole(actor, Role.ADMIN, Role.EXAMINER, Role.LEARNER);
  switch (actor.role) {
    case Role.ADMIN:
      return {};
    case Role.EXAMINER:
      return { examinerId: actor.id };
    default:
      return { learnerId: actor.id };
  }
}

function candidateSelect(actor: SessionUser) {
  return {
    id: true,
    assessmentId: true,
    createdAt: true,
    learner: { select: { id: true, name: true, email: true, status: true } },
    // Learners don't see who marks them.
    ...(actor.role === Role.LEARNER
      ? {}
      : { examinerAssignedAt: true, examiner: { select: { id: true, name: true, email: true } } }),
  } satisfies Prisma.AssessmentCandidateSelect;
}

/** Candidates of one assessment visible to the actor (all for admin; own assignments for an examiner). */
export async function listCandidates(actor: SessionUser, assessmentId: string) {
  const scope = candidateScope(actor);
  return db.assessmentCandidate.findMany({
    // AND, not spread: request fields must never overwrite the scope (e.g. a learner's assessment).
    where: { AND: [scope, { assessmentId }] },
    orderBy: [{ learner: { name: "asc" } }],
    select: candidateSelect(actor),
  });
}

/**
 * One candidate, by id, within an assessment. Anything outside the actor's scope — another
 * examiner's candidate, an unassigned one, a candidate of a different assessment or a made-up id —
 * is reported as not found, so the response doesn't reveal that it exists.
 */
export async function getCandidate(actor: SessionUser, assessmentId: string, candidateId: string) {
  const scope = candidateScope(actor);
  const candidate = await db.assessmentCandidate.findFirst({
    where: { AND: [scope, { id: candidateId, assessmentId }] },
    select: candidateSelect(actor),
  });
  if (!candidate) throw new NotFoundError("Candidate not found.");
  return candidate;
}

/** Assessments in which the examiner has at least one assigned candidate. */
export async function listExaminerAssessments(actor: SessionUser) {
  assertRole(actor, Role.EXAMINER);
  const rows = await db.assessmentCandidate.groupBy({ by: ["assessmentId"], where: { examinerId: actor.id }, _count: { _all: true } });
  const assessments = await db.assessment.findMany({
    where: { id: { in: rows.map((r) => r.assessmentId) } },
    select: { id: true, name: true, status: true, startAt: true, endAt: true },
    orderBy: { startAt: "desc" },
  });
  const counts = new Map(rows.map((r) => [r.assessmentId, r._count._all]));
  return assessments.map((a) => ({ ...a, assignedCandidates: counts.get(a.id) ?? 0 }));
}

/** The learner's candidate row for the request's assessment (see forAssessment). */
export async function getMyCandidacy(actor: SessionUser) {
  assertRole(actor, Role.LEARNER);
  if (!actor.assessmentId) throw new ForbiddenError();
  const candidate = await db.assessmentCandidate.findFirst({
    where: { AND: [candidateScope(actor), { assessmentId: actor.assessmentId }] },
    select: {
      id: true,
      assessment: { select: { id: true, name: true, description: true, status: true, startAt: true, endAt: true, durationMinutes: true, maxAttempts: true } },
    },
  });
  if (!candidate) throw new NotFoundError("Assessment not found.");
  return candidate;
}

// ---------------------------------------------------------------------------
// Admin: assigning candidates to an assessment
// ---------------------------------------------------------------------------

async function lockAssessmentForCandidates(tx: DbTx, assessmentId: string) {
  const a = await tx.assessment.findUnique({ where: { id: assessmentId }, select: { id: true, status: true } });
  if (!a) throw new NotFoundError("Assessment not found.");
  if (!CANDIDATE_EDITABLE.includes(a.status)) throw new ConflictError("Candidates can’t be changed once the assessment has ended.");
  return a;
}

/** Assign learners to sit an assessment. Already-assigned learners are skipped. Returns the number added. */
export async function assignLearnersToAssessment(actor: SessionUser, assessmentId: string, learnerIds: string[]) {
  assertAdmin(actor);
  if (learnerIds.length === 0) throw new ValidationError("Choose at least one learner.");
  return db.$transaction(async (tx) => {
    await lockAssessmentForCandidates(tx, assessmentId);
    const ids = await assertLearners(tx, learnerIds);
    const { count } = await tx.assessmentCandidate.createMany({
      data: ids.map((learnerId) => ({ assessmentId, learnerId })),
      skipDuplicates: true,
    });
    await recordAudit({ actorId: actor.id, action: AuditAction.CANDIDATES_ASSIGNED, entityType: "Assessment", entityId: assessmentId, metadata: { added: count } }, tx);
    return count;
  });
}

/** Assign every learner in a batch to the assessment. */
export async function assignBatchToAssessment(actor: SessionUser, assessmentId: string, batchId: string) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const a = await lockAssessmentForCandidates(tx, assessmentId);
    return insertBatchCandidates(tx, actor.id, a, batchId);
  });
}

/**
 * Inside a transaction: make the batch's learners candidates of the assessment (already-assigned
 * learners are skipped) and audit it. `activeOnly` skips disabled learner accounts. Returns the number added.
 */
export async function insertBatchCandidates(
  tx: DbTx,
  actorId: string,
  assessment: { id: string },
  batchId: string,
  { activeOnly = false }: { activeOnly?: boolean } = {},
) {
  const batch = await tx.batch.findUnique({
    where: { id: batchId },
    select: {
      members: { where: { user: { role: Role.LEARNER, ...(activeOnly ? { status: UserStatus.ACTIVE } : {}) } }, select: { userId: true } },
    },
  });
  if (!batch) throw new NotFoundError("Batch not found.");
  const { count } = await tx.assessmentCandidate.createMany({
    data: batch.members.map((m) => ({ assessmentId: assessment.id, learnerId: m.userId })),
    skipDuplicates: true,
  });
  await recordAudit(
    { actorId, action: AuditAction.CANDIDATES_ASSIGNED, entityType: "Assessment", entityId: assessment.id, metadata: { added: count, batchId } },
    tx,
  );
  return count;
}

/** Remove a candidate. Their exam credentials (and any exam session) go with them. */
export async function removeCandidate(actor: SessionUser, assessmentId: string, candidateId: string) {
  assertAdmin(actor);
  await db.$transaction(async (tx) => {
    await lockAssessmentForCandidates(tx, assessmentId);
    if (await tx.assessmentAttempt.count({ where: { candidateId, assessmentId } })) {
      throw new ConflictError("This candidate has already started the assessment and can’t be removed.");
    }
    const { count } = await tx.assessmentCandidate.deleteMany({ where: { id: candidateId, assessmentId } });
    if (count === 0) throw new NotFoundError("Candidate not found.");
    await recordAudit({ actorId: actor.id, action: AuditAction.CANDIDATE_REMOVED, entityType: "AssessmentCandidate", entityId: candidateId, metadata: { assessmentId } }, tx);
  });
}

// ---------------------------------------------------------------------------
// Admin: examiner assignment (per assessment)
// ---------------------------------------------------------------------------

/**
 * Assign (or reassign) candidates of one assessment to an examiner; `examinerId: null` unassigns.
 * Only candidates of this assessment are touched, so an assignment never leaks into another one.
 */
export async function assignExaminer(actor: SessionUser, assessmentId: string, candidateIds: string[], examinerId: string | null) {
  assertAdmin(actor);
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) throw new ValidationError("Choose at least one candidate.");

  return db.$transaction(async (tx) => {
    const a = await tx.assessment.findUnique({ where: { id: assessmentId }, select: { status: true } });
    if (!a) throw new NotFoundError("Assessment not found.");
    if (a.status === AssessmentStatus.ARCHIVED) throw new ConflictError("Archived assessments can’t be changed.");

    if (examinerId) {
      const examiner = await tx.user.findUnique({ where: { id: examinerId }, select: { role: true, status: true } });
      if (!examiner || examiner.role !== Role.EXAMINER) throw new ValidationError("Choose an examiner account.");
      if (examiner.status !== UserStatus.ACTIVE) throw new ValidationError("This examiner account is disabled.");
    }

    const inAssessment = await tx.assessmentCandidate.count({ where: { id: { in: ids }, assessmentId } });
    if (inAssessment !== ids.length) throw new NotFoundError("One or more candidates are not part of this assessment.");

    const { count } = await tx.assessmentCandidate.updateMany({
      where: { id: { in: ids }, assessmentId },
      data: { examinerId, examinerAssignedAt: examinerId ? new Date() : null },
    });
    await recordAudit(
      { actorId: actor.id, action: AuditAction.EXAMINER_ASSIGNED, entityType: "Assessment", entityId: assessmentId, metadata: { examinerId, candidateIds: ids } },
      tx,
    );
    return count;
  });
}
