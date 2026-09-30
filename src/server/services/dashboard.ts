import "server-only";
import { Role, UserStatus } from "@/generated/prisma/enums";
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
