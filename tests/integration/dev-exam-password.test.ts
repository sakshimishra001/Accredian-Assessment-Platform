import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { authenticateLearner } from "@/server/auth/exam-login";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { devExamPasswordProblem, resetDevLearnerPassword } from "../../scripts/dev-exam-password";
import { createAssessmentRow, createExamAccess, createUser, resetDatabase } from "./helpers";

/* The development-only learner password utility (scripts/dev-exam-password.ts), against assessment_test. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

describe("dev learner password utility", () => {
  it("sets the learner's one password through the service; it signs in, the old one stops, sessions end", async () => {
    const admin = await createUser({ role: Role.ADMIN, email: "creator.admin@example.com" });
    const learner = await createUser({ role: Role.LEARNER, email: "lina.dev@example.com" });
    const other = await createUser({ role: Role.LEARNER });
    const assessment = await createAssessmentRow({ createdById: admin.id, status: "SCHEDULED" });
    await createExamAccess({ learnerId: learner.id, assessmentId: assessment.id, issuedById: admin.id });

    const first = await resetDevLearnerPassword({ learner: "LINA.dev@example.com" });
    expect(first).toMatchObject({ learnerEmail: "lina.dev@example.com", issuedBy: "creator.admin@example.com", assessments: [expect.objectContaining({ id: assessment.id })] });
    expect(first.password).toMatch(/^[A-Z0-9]{10}$/);
    const row = await db.user.findUniqueOrThrow({ where: { id: learner.id } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(first.password);
    expect(await authenticateLearner(learner.email, first.password)).toMatchObject({ ok: true, method: "password" });

    await createSession(learner.id, {}, { kind: "learner" });
    const second = await resetDevLearnerPassword({ learner: learner.id });
    expect(await authenticateLearner(learner.email, first.password)).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(await authenticateLearner(learner.email, second.password)).toMatchObject({ ok: true });
    // The reset ended the sessions opened before it (only the sign-in above remains).
    expect(await db.session.count({ where: { userId: learner.id } })).toBe(1);
    // Nobody else is touched.
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).passwordHash).toBeNull();
  });

  it("refuses an unknown user or a non-learner, changing nothing", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    await expect(resetDevLearnerPassword({ learner: "nobody@example.com" })).rejects.toThrow(/not found/);
    await expect(resetDevLearnerPassword({ learner: admin.email })).rejects.toThrow(/isn't a learner/);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).passwordHash).toBe(admin.passwordHash);
  });

  it("never runs in production", () => {
    expect(devExamPasswordProblem({ NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost:5432/assessment_dev" })).toMatch(/NODE_ENV is "production"/);
    expect(devExamPasswordProblem({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@localhost:5432/assessment_dev" })).toBeNull();
  });
});
