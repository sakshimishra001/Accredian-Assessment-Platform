import "server-only";
import { AttemptStatus, EvaluationStatus, Role } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db } from "../db";

/*
 * Admin view of examiners: their accounts plus their real workload — candidates assigned to them
 * per assessment, submitted attempts awaiting their evaluation, and evaluations they finalised.
 * Accounts themselves are created and disabled in Users & Roles (see services/staff.ts).
 */

const SUBMITTED = [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED];
const OPEN_EVALUATION = [EvaluationStatus.PENDING, EvaluationStatus.IN_PROGRESS];

export async function listExaminers(actor: SessionUser) {
  assertAdmin(actor);
  const [examiners, assigned, pending, completed] = await Promise.all([
    db.user.findMany({ where: { role: Role.EXAMINER }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, status: true, lastLoginAt: true } }),
    db.assessmentCandidate.groupBy({ by: ["examinerId", "assessmentId"], where: { examinerId: { not: null } } }),
    db.assessmentAttempt.findMany({ where: { status: { in: SUBMITTED }, evaluationStatus: { in: OPEN_EVALUATION }, candidate: { examinerId: { not: null } } }, select: { candidate: { select: { examinerId: true } } } }),
    db.assessmentAttempt.groupBy({ by: ["evaluationFinalizedById"], where: { evaluationStatus: EvaluationStatus.COMPLETED, evaluationFinalizedById: { not: null } }, _count: { _all: true } }),
  ]);
  const count = <T,>(items: T[], key: (t: T) => string | null) => items.reduce((m, t) => m.set(key(t) ?? "", (m.get(key(t) ?? "") ?? 0) + 1), new Map<string, number>());
  const assignedBy = count(assigned, (r) => r.examinerId);
  const pendingBy = count(pending, (r) => r.candidate.examinerId);
  const completedBy = new Map(completed.map((r) => [r.evaluationFinalizedById ?? "", r._count._all]));
  return examiners.map((e) => ({ ...e, assignedAssessments: assignedBy.get(e.id) ?? 0, pendingEvaluations: pendingBy.get(e.id) ?? 0, completedEvaluations: completedBy.get(e.id) ?? 0 }));
}

export async function getExaminerOverview(actor: SessionUser, examinerId: string) {
  assertAdmin(actor);
  const examiner = await db.user.findFirst({ where: { id: examinerId, role: Role.EXAMINER }, select: { id: true, name: true, email: true, status: true, lastLoginAt: true, createdAt: true } });
  if (!examiner) throw new NotFoundError("Examiner not found.");

  const assignedRows = await db.assessmentCandidate.groupBy({ by: ["assessmentId"], where: { examinerId }, _count: { _all: true } });
  const counts = new Map(assignedRows.map((r) => [r.assessmentId, r._count._all]));
  const attemptSelect = {
    id: true,
    submittedAt: true,
    evaluationStatus: true,
    evaluationFinalizedAt: true,
    learner: { select: { name: true, email: true } },
    assessment: { select: { id: true, name: true } },
  } as const;
  const [assessments, pending, completed] = await Promise.all([
    db.assessment.findMany({
      where: { id: { in: [...counts.keys()] } },
      orderBy: { startAt: "desc" },
      select: { id: true, name: true, status: true, startAt: true, batch: { select: { name: true } } },
    }),
    db.assessmentAttempt.findMany({ where: { status: { in: SUBMITTED }, evaluationStatus: { in: OPEN_EVALUATION }, candidate: { examinerId } }, orderBy: { submittedAt: "asc" }, select: attemptSelect }),
    db.assessmentAttempt.findMany({ where: { evaluationStatus: EvaluationStatus.COMPLETED, evaluationFinalizedById: examinerId }, orderBy: { evaluationFinalizedAt: "desc" }, take: 100, select: attemptSelect }),
  ]);
  return { examiner, assessments: assessments.map((a) => ({ ...a, assignedCandidates: counts.get(a.id) ?? 0 })), pending, completed };
}
