import { AssessmentStatus, ExamCredentialStatus, Role, UserStatus } from "@/generated/prisma/enums";
import { hashPassword } from "@/server/auth/password";
import type { SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { resetLoginThrottle } from "@/server/security/login-throttle";
import { resetRecentlyRecorded } from "@/server/security/recent";
import { addPaperQuestion, addSection, createQuestionPaper } from "@/server/services/question-papers";

export const TEST_PASSWORD = "correct-horse-battery";

let cachedHash: string | undefined;

export async function resetDatabase() {
  // Defence in depth (getTestDatabaseUrl already checks the URL): never wipe a non-test database.
  const [{ name }] = await db.$queryRawUnsafe<{ name: string }[]>("SELECT current_database() AS name");
  if (!/test/i.test(name) || process.env.NODE_ENV === "production") throw new Error(`Refusing to reset database "${name}": not a test database.`);
  // In-process sign-in throttle counters are per process; start each test clean.
  resetLoginThrottle();
  resetRecentlyRecorded();
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "paper_questions", "paper_sections", "question_papers", "exam_credentials", "assessment_candidates", "assessment_questions", "assessments", "question_options", "questions",
      "audit_logs", "batch_members", "batches", "courses", "sessions", "users",
      "stored_files", "paper_question_materials", "answer_attachments", "communication_templates", "assessment_communication_settings", "communication_logs",
      "password_tokens" CASCADE`,
  );
}

/**
 * Staff users get TEST_PASSWORD. Learners get no password (as in production) unless
 * `withPassword` is set, which simulates a legacy row that still has one.
 */
export async function createUser(
  overrides: Partial<{ email: string; name: string; role: Role; status: UserStatus; withPassword: boolean }> = {},
) {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  const role = overrides.role ?? Role.LEARNER;
  const withPassword = overrides.withPassword ?? role !== Role.LEARNER;
  return db.user.create({
    data: {
      email: overrides.email ?? `user-${crypto.randomUUID()}@example.com`,
      name: overrides.name ?? "Test User",
      role,
      status: overrides.status ?? UserStatus.ACTIVE,
      passwordHash: withPassword ? cachedHash : null,
    },
  });
}

export const TEST_EXAM_CODE = "X7K92P";
let cachedCodeHash: string | undefined;

/**
 * An assessment row in a given lifecycle state, open from an hour ago for two hours by default.
 * Created directly (not via the service) so tests can pick any status.
 */
export async function createAssessmentRow(
  overrides: Partial<{ status: AssessmentStatus; startAt: Date; endAt: Date; courseId: string; name: string; createdById: string }> = {},
) {
  const courseId = overrides.courseId ?? (await createCourse()).id;
  const createdById = overrides.createdById ?? (await createUser({ role: Role.ADMIN })).id;
  return db.assessment.create({
    data: {
      name: overrides.name ?? `Exam ${crypto.randomUUID().slice(0, 6)}`,
      courseId,
      type: "OBJECTIVE",
      status: overrides.status ?? AssessmentStatus.ACTIVE,
      durationMinutes: 60,
      startAt: overrides.startAt ?? hoursFromNow(-1),
      endAt: overrides.endAt ?? hoursFromNow(1),
      maxAttempts: 1,
      passingMarks: 1,
      createdById,
    },
  });
}

/**
 * A learner assigned to an assessment with an exam credential for TEST_EXAM_CODE (or `code`).
 * The window defaults to the assessment schedule.
 */
export async function createExamAccess(opts: {
  learnerId: string;
  assessmentId: string;
  issuedById: string;
  code?: string;
  validFrom?: Date;
  validUntil?: Date;
  status?: ExamCredentialStatus;
}) {
  const assessment = await db.assessment.findUniqueOrThrow({ where: { id: opts.assessmentId } });
  const candidate = await db.assessmentCandidate.upsert({
    where: { assessmentId_learnerId: { assessmentId: opts.assessmentId, learnerId: opts.learnerId } },
    update: {},
    create: { assessmentId: opts.assessmentId, learnerId: opts.learnerId },
  });
  const codeHash = opts.code ? await hashPassword(opts.code) : (cachedCodeHash ??= await hashPassword(TEST_EXAM_CODE));
  const credential = await db.examCredential.create({
    data: {
      candidateId: candidate.id,
      codeHash,
      status: opts.status ?? ExamCredentialStatus.ACTIVE,
      validFrom: opts.validFrom ?? assessment.startAt,
      validUntil: opts.validUntil ?? assessment.endAt,
      issuedById: opts.issuedById,
    },
  });
  return { candidate, credential };
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

export interface PaperSectionSpec {
  title?: string;
  attemptRule?: string;
  attemptCount?: number;
  questions: Record<string, unknown>[];
}

/**
 * A complete question paper of `courseId`, built through the real services — usable in an
 * assessment as soon as it is saved (papers need no review or approval). Each entry of `sections`
 * becomes a section with those questions (default: one section, two MCQs). Returns the paper id
 * and the bank question ids in paper order.
 */
export async function createReadyPaper(
  admin: SessionUser,
  courseId: string,
  opts: { name?: string; sections?: PaperSectionSpec[] } = {},
) {
  const paper = await createQuestionPaper(admin, { name: opts.name ?? "Final paper", courseId });
  const sections: PaperSectionSpec[] = opts.sections ?? [{ questions: [mcqSingle({ text: "Q1" }), mcqSingle({ text: "Q2" })] }];
  for (const [i, s] of sections.entries()) {
    const section = await addSection(admin, paper.id, { title: s.title ?? `Section ${i + 1}`, attemptRule: s.attemptRule, attemptCount: s.attemptCount });
    for (const q of s.questions) await addPaperQuestion(admin, section.id, q);
  }
  const items = await db.paperQuestion.findMany({
    where: { paperId: paper.id, questionId: { not: null } },
    orderBy: [{ section: { position: "asc" } }, { position: "asc" }],
    select: { questionId: true },
  });
  return { id: paper.id, questionIds: items.map((i) => i.questionId!) };
}

/** An active batch in `courseId` with `count` active learners. */
export async function createBatchWithLearners(courseId: string, count = 2) {
  const batch = await db.batch.create({ data: { name: `Batch ${crypto.randomUUID().slice(0, 6)}`, courseId } });
  for (let i = 0; i < count; i++) {
    const learner = await createUser({ role: Role.LEARNER, name: `Learner ${i + 1}` });
    await db.batchMember.create({ data: { batchId: batch.id, userId: learner.id } });
  }
  return batch;
}
