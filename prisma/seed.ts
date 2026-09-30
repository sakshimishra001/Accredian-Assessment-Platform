/**
 * Development seed. Idempotent: safe to run repeatedly (upserts by unique keys).
 * Demo account password comes from SEED_USER_PASSWORD so no credential lives in source control.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { Role } from "../src/generated/prisma/enums";

const password = process.env.SEED_USER_PASSWORD;
if (!password || password.length < 8) {
  console.error("SEED_USER_PASSWORD must be set (min 8 characters) in .env before seeding.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL must be set in .env before seeding.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const users = [
  { email: "admin@example.com", name: "Asha Admin", role: Role.ADMIN },
  { email: "examiner@example.com", name: "Eshan Examiner", role: Role.EXAMINER },
  { email: "learner1@example.com", name: "Lina Learner", role: Role.LEARNER },
  { email: "learner2@example.com", name: "Leo Learner", role: Role.LEARNER },
];

async function main() {
  const passwordHash = await bcrypt.hash(password!, 12);

  const created = await Promise.all(
    users.map((u) =>
      prisma.user.upsert({
        where: { email: u.email },
        update: { name: u.name, role: u.role, passwordHash, status: "ACTIVE" },
        create: { ...u, passwordHash },
      }),
    ),
  );

  const course = await prisma.course.upsert({
    where: { code: "DSF-101" },
    update: {},
    create: {
      code: "DSF-101",
      name: "Data Science Foundations",
      description: "Introductory programme covering statistics, Python and SQL.",
    },
  });

  const batch = await prisma.batch.upsert({
    where: { code: "DSF-101-2026A" },
    update: {},
    create: {
      code: "DSF-101-2026A",
      name: "DSF-101 Batch 2026-A",
      courseId: course.id,
      startDate: new Date("2026-07-01T00:00:00+05:30"),
      endDate: new Date("2026-12-31T00:00:00+05:30"),
    },
  });

  const learners = created.filter((u) => u.role === Role.LEARNER);
  await prisma.batchMember.createMany({
    data: learners.map((l) => ({ batchId: batch.id, userId: l.id })),
    skipDuplicates: true,
  });

  const admin = created.find((u) => u.role === Role.ADMIN)!;
  const questionCount = await seedQuestionBank(admin.id, course.id);

  console.log("Seed complete:");
  for (const u of created) console.log(`  ${u.role.padEnd(8)} ${u.email}`);
  console.log(`  COURSE   ${course.code} — ${course.name}`);
  console.log(`  BATCH    ${batch.code} (${learners.length} learners)`);
  console.log(`  BANK     ${questionCount} sample questions (+ a draft sample assessment)`);
  console.log("All demo accounts use the password from SEED_USER_PASSWORD.");
}

const SAMPLE_QUESTIONS = [
  {
    type: "MCQ_SINGLE",
    text: "Which measure of central tendency is least affected by outliers?",
    marks: 2,
    negativeMarks: 0.5,
    topic: "Descriptive statistics",
    difficulty: "EASY",
    options: [
      { text: "Mean", isCorrect: false },
      { text: "Median", isCorrect: true },
      { text: "Range", isCorrect: false },
      { text: "Standard deviation", isCorrect: false },
    ],
  },
  {
    type: "MCQ_MULTI",
    text: "Which of the following are valid SQL JOIN types?",
    marks: 3,
    negativeMarks: 1,
    topic: "SQL",
    difficulty: "MEDIUM",
    options: [
      { text: "INNER JOIN", isCorrect: true },
      { text: "LEFT JOIN", isCorrect: true },
      { text: "SIDEWAYS JOIN", isCorrect: false },
      { text: "FULL OUTER JOIN", isCorrect: true },
    ],
  },
  {
    type: "TRUE_FALSE",
    text: "A p-value is the probability that the null hypothesis is true.",
    marks: 1,
    negativeMarks: 0,
    topic: "Inference",
    difficulty: "MEDIUM",
    guidance: "False — it is the probability of data at least this extreme, assuming the null is true.",
    options: [
      { text: "True", isCorrect: false },
      { text: "False", isCorrect: true },
    ],
  },
  {
    type: "SHORT_ANSWER",
    text: "In one or two sentences, explain what overfitting is.",
    marks: 4,
    negativeMarks: 0,
    topic: "Machine learning",
    difficulty: "MEDIUM",
    guidance: "Model fits noise in training data and generalises poorly to unseen data.",
    options: [],
  },
  {
    type: "LONG_ANSWER",
    text: "Describe how you would design an A/B test for a new checkout page, including metrics and sample size considerations.",
    marks: 10,
    negativeMarks: 0,
    topic: "Experimentation",
    difficulty: "HARD",
    guidance: "Hypothesis, primary metric (conversion), guardrails, randomisation unit, power analysis, duration, analysis plan.",
    options: [],
  },
] as const;

/** Adds sample questions (skipped if the bank already has questions) and one draft MIXED assessment. */
async function seedQuestionBank(adminId: string, courseId: string) {
  if ((await prisma.question.count()) > 0) return prisma.question.count();

  const ids: string[] = [];
  for (const q of SAMPLE_QUESTIONS) {
    const { options, ...rest } = q;
    const row = await prisma.question.create({
      data: {
        ...rest,
        guidance: "guidance" in q ? q.guidance : null,
        courseId,
        createdById: adminId,
        options: { create: options.map((o, position) => ({ ...o, position })) },
      },
      include: { options: true },
    });
    ids.push(row.id);
  }

  const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  start.setUTCHours(4, 30, 0, 0); // 10:00 IST
  const assessment = await prisma.assessment.create({
    data: {
      name: "Sample: Data Science Foundations quiz",
      description: "Answer every question. Objective questions carry negative marking where shown.",
      courseId,
      type: "MIXED",
      durationMinutes: 60,
      startAt: start,
      endAt: new Date(start.getTime() + 3 * 3600 * 1000),
      maxAttempts: 1,
      passingMarks: 8,
      createdById: adminId,
    },
  });
  const questions = await prisma.question.findMany({ where: { id: { in: ids } }, include: { options: true } });
  for (const [i, id] of ids.entries()) {
    const q = questions.find((x) => x.id === id)!;
    await prisma.assessmentQuestion.create({
      data: {
        assessmentId: assessment.id,
        questionId: id,
        position: i + 1,
        marks: q.marks,
        negativeMarks: q.negativeMarks,
        questionVersion: q.version,
        snapshot: {
          questionId: q.id,
          version: q.version,
          type: q.type,
          text: q.text,
          guidance: q.guidance,
          topic: q.topic,
          difficulty: q.difficulty,
          options: q.options
            .sort((a, b) => a.position - b.position)
            .map(({ id: optionId, text, isCorrect, position }) => ({ id: optionId, text, isCorrect, position })),
        },
      },
    });
  }
  return ids.length;
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
