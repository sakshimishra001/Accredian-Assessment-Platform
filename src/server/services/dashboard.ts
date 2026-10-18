import "server-only";
import { AssessmentStatus, AttemptStatus, EvaluationStatus, Role, UserStatus } from "@/generated/prisma/enums";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db } from "../db";

export async function getAdminDashboard() {
  const [usersByRole, courseCount, batchCount, courses, recentActivity] = await Promise.all([
    db.user.groupBy({ by: ["role"], where: { status: UserStatus.ACTIVE }, _count: { _all: true } }),
    db.course.count({ where: { isActive: true } }),
    db.batch.count({ where: { isActive: true } }),
    db.course.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      take: 10,
      select: {
        id: true,
        code: true,
        name: true,
        batches: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, code: true, name: true, _count: { select: { members: true } } },
        },
      },
    }),
    db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        action: true,
        createdAt: true,
        ipAddress: true,
        actor: { select: { name: true, email: true } },
      },
    }),
  ]);

  const countFor = (role: Role) => usersByRole.find((r) => r.role === role)?._count._all ?? 0;

  return {
    counts: {
      learners: countFor(Role.LEARNER),
      examiners: countFor(Role.EXAMINER),
      admins: countFor(Role.ADMIN),
      courses: courseCount,
      batches: batchCount,
    },
    courses,
    recentActivity,
  };
}

export async function getLearnerDashboard(userId: string) {
  const memberships = await db.batchMember.findMany({
    where: { userId, batch: { isActive: true } },
    orderBy: { createdAt: "asc" },
    select: {
      batch: {
        select: {
          id: true,
          code: true,
          name: true,
          startDate: true,
          endDate: true,
          course: { select: { code: true, name: true } },
        },
      },
    },
  });
  return { batches: memberships.map((m) => m.batch) };
}

export async function getExaminerDashboard(userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { lastLoginAt: true, createdAt: true },
  });
  return { profile: user };
}

const IST_OFFSET_MS = 330 * 60_000;

/** Assessment events shown as recent activity (status changes cover publishing and result publication). */
const RECENT_ACTIONS = ["assessment.created", "assessment.status_changed", "exam_credential.issued"] as const;
const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The admin dashboard, from PostgreSQL: assessments by status, the evaluation backlog (per examiner),
 * what's coming up, and learner submissions per day (IST) over the last `days` days.
 */
export async function getAdminOverview(actor: SessionUser, days: number, now: Date = new Date()) {
  assertAdmin(actor);
  const since = new Date(now.getTime() - days * 86_400_000);
  const openEvaluation = {
    status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED] },
    evaluationStatus: { in: [EvaluationStatus.PENDING, EvaluationStatus.IN_PROGRESS] },
  };
  const [byStatus, learners, batches, papers, upcoming, backlog, submissions, activity] = await Promise.all([
    db.assessment.groupBy({ by: ["status"], _count: { _all: true } }),
    db.user.count({ where: { role: Role.LEARNER, status: UserStatus.ACTIVE } }),
    db.batch.count({ where: { isActive: true } }),
    db.questionPaper.count(),
    db.assessment.findMany({
      where: { status: AssessmentStatus.SCHEDULED, startAt: { gte: now } },
      orderBy: { startAt: "asc" },
      take: 5,
      select: { id: true, name: true, startAt: true, batch: { select: { name: true } }, _count: { select: { candidates: true } } },
    }),
    db.assessmentAttempt.findMany({ where: openEvaluation, select: { submittedAt: true, candidate: { select: { examiner: { select: { id: true, name: true } } } } } }),
    db.assessmentAttempt.findMany({ where: { submittedAt: { gte: since, lte: now } }, select: { submittedAt: true } }),
    db.auditLog.findMany({
      where: { entityType: "Assessment", action: { in: [...RECENT_ACTIONS] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, action: true, entityId: true, metadata: true, createdAt: true, actor: { select: { name: true } } },
    }),
  ]);
  const names = new Map(
    (await db.assessment.findMany({ where: { id: { in: activity.map((a) => a.entityId!).filter(Boolean) } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]),
  );

  const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])) as Partial<Record<AssessmentStatus, number>>;
  const perExaminer = new Map<string, { id: string | null; name: string; count: number; oldest: Date | null }>();
  for (const a of backlog) {
    const ex = a.candidate.examiner;
    const key = ex?.id ?? "";
    const row = perExaminer.get(key) ?? { id: ex?.id ?? null, name: ex?.name ?? "Not assigned", count: 0, oldest: null };
    row.count++;
    if (a.submittedAt && (!row.oldest || a.submittedAt < row.oldest)) row.oldest = a.submittedAt;
    perExaminer.set(key, row);
  }
  const perDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) perDay.set(istDay(new Date(now.getTime() - i * 86_400_000)), 0);
  for (const s of submissions) {
    const key = istDay(s.submittedAt!);
    if (perDay.has(key)) perDay.set(key, perDay.get(key)! + 1);
  }

  return {
    statusCounts,
    totalAssessments: byStatus.reduce((n, r) => n + r._count._all, 0),
    pendingEvaluations: backlog.length,
    learners,
    batches,
    papers,
    upcoming,
    backlogByExaminer: [...perExaminer.values()].sort((a, b) => b.count - a.count),
    submissionsPerDay: [...perDay.entries()].map(([date, value]) => ({ date: `${date}T06:30:00.000Z`, value })),
    totalSubmissions: submissions.length,
    recentActivity: activity
      .filter((a) => a.entityId && names.has(a.entityId))
      .map((a) => ({
        id: a.id,
        action: a.action,
        assessmentId: a.entityId!,
        assessmentName: names.get(a.entityId!)!,
        metadata: (a.metadata ?? {}) as { from?: AssessmentStatus; to?: AssessmentStatus; count?: number },
        actorName: a.actor?.name ?? null,
        at: a.createdAt,
      })),
  };
}
