import { Role, UserStatus } from "@/generated/prisma/enums";
import { hashPassword } from "@/server/auth/password";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";

export const TEST_PASSWORD = "correct-horse-battery";

let cachedHash: string | undefined;

export async function resetDatabase() {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "assessment_questions", "assessments", "question_options", "questions",
      "audit_logs", "batch_members", "batches", "courses", "sessions", "users" CASCADE`,
  );
}

export async function createUser(
  overrides: Partial<{ email: string; name: string; role: Role; status: UserStatus }> = {},
) {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  return db.user.create({
    data: {
      email: overrides.email ?? `user-${crypto.randomUUID()}@example.com`,
      name: overrides.name ?? "Test User",
      role: overrides.role ?? Role.LEARNER,
      status: overrides.status ?? UserStatus.ACTIVE,
      passwordHash: cachedHash,
    },
  });
}

export async function createActor(role: Role = Role.ADMIN): Promise<SessionUser> {
  const u = await createUser({ role, name: `${role} user` });
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export async function createCourse(code = `C-${crypto.randomUUID().slice(0, 8)}`) {
  return db.course.create({ data: { code, name: `Course ${code}` } });
}

/** A date `hours` from now, rounded to the minute (matches datetime-local precision). */
export function hoursFromNow(hours: number) {
  const d = new Date(Date.now() + hours * 3_600_000);
  d.setSeconds(0, 0);
  return d;
}

export const mcqSingle = (overrides: Record<string, unknown> = {}) => ({
  type: "MCQ_SINGLE",
  text: "Which is a prime number?",
  marks: 2,
  negativeMarks: 0.5,
  topic: "Numbers",
  difficulty: "EASY",
  options: [
    { text: "4", isCorrect: false },
    { text: "7", isCorrect: true },
    { text: "9", isCorrect: false },
  ],
  ...overrides,
});

export const shortAnswer = (overrides: Record<string, unknown> = {}) => ({
  type: "SHORT_ANSWER",
  text: "Define variance.",
  marks: 5,
  topic: "Statistics",
  difficulty: "MEDIUM",
  ...overrides,
});

export const assessmentInput = (courseId: string, overrides: Record<string, unknown> = {}) => ({
  name: "Unit test",
  description: "Read carefully.",
  courseId,
  type: "OBJECTIVE",
  durationMinutes: 60,
  startAt: hoursFromNow(24),
  endAt: hoursFromNow(26),
  maxAttempts: 1,
  passingMarks: 1,
  resultVisibility: "ON_PUBLISH",
  proctoringEnabled: false,
  ...overrides,
});
