import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, getAssessment, publishAssessment, updateAssessment } from "@/server/services/assessments";
import { getMyAttempt, startOrResumeAttempt } from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase } from "./helpers";

/* The calculator learner tool: an assessment setting (PostgreSQL) shown in the learner's exam. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

async function draft(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, { sections: [{ questions: [mcqSingle({ text: "Q1" }), mcqSingle({ text: "Q2" })] }] });
  const batch = await createBatchWithLearners(course.id, 1);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 120), ...settings }));
  return { admin, assessment, batch, startAt };
}

async function learnerView(admin: Awaited<ReturnType<typeof createActor>>, assessmentId: string, batchId: string, startAt: Date) {
  await publishAssessment(admin, assessmentId);
  await assignBatchToAssessment(admin, assessmentId, batchId);
  const [cred] = await issueExamCredentials(admin, assessmentId);
  const T = at(startAt, 5);
  const r = await authenticateExamCredential(cred.learner.email, cred.code, {}, T);
  if (!r.ok) throw new Error(r.reason);
  const user = (await validateSessionToken(r.token, T))!;
  return { user, view: await startOrResumeAttempt(user, T), T };
}

describe("calculator configuration", () => {
  it("is off by default", async () => {
    const { admin, assessment } = await draft();
    expect((await getAssessment(admin, assessment.id)).settings).toMatchObject({ calculatorEnabled: false, calculatorType: "BASIC" });
  });

  it("enabled and type persist through saving, reopening and publishing; a partial save doesn't reset them", async () => {
    const { admin, assessment } = await draft({ calculatorEnabled: true, calculatorType: "SCIENTIFIC" });
    expect((await getAssessment(admin, assessment.id)).settings).toMatchObject({ calculatorEnabled: true, calculatorType: "SCIENTIFIC" });
    await updateAssessment(admin, assessment.id, { name: "Renamed exam" });
    expect((await getAssessment(admin, assessment.id)).settings).toMatchObject({ calculatorEnabled: true, calculatorType: "SCIENTIFIC" });
    await updateAssessment(admin, assessment.id, { calculatorType: "BASIC" });
    expect(await db.assessment.findUniqueOrThrow({ where: { id: assessment.id }, select: { calculatorEnabled: true, calculatorType: true } })).toEqual({ calculatorEnabled: true, calculatorType: "BASIC" });
    await publishAssessment(admin, assessment.id);
    expect((await getAssessment(admin, assessment.id)).settings).toMatchObject({ calculatorEnabled: true, calculatorType: "BASIC" });
    await expect(updateAssessment(admin, assessment.id, { calculatorType: "TABLET" })).rejects.toMatchObject({ fieldErrors: { calculatorType: expect.any(Array) } });
  });

  it("can be changed while scheduled, but not once the exam is live", async () => {
    const { admin, assessment, batch, startAt } = await draft();
    await publishAssessment(admin, assessment.id);
    await updateAssessment(admin, assessment.id, { calculatorEnabled: true });
    expect((await getAssessment(admin, assessment.id)).settings.calculatorEnabled).toBe(true);
    await assignBatchToAssessment(admin, assessment.id, batch.id);
    const live = at(startAt, 5);
    await expect(updateAssessment(admin, assessment.id, { calculatorEnabled: false }, live)).rejects.toThrow(/Calculator cannot be changed while the assessment is active/);
  });
});

describe("learner exam", () => {
  it("calculator off: the exam offers none", async () => {
    const { admin, assessment, batch, startAt } = await draft();
    const { view } = await learnerView(admin, assessment.id, batch.id, startAt);
    expect(view.assessment.calculator).toBeNull();
  });

  it("calculator on: the exam offers the configured type; it is purely a browser tool (no server state)", async () => {
    const { admin, assessment, batch, startAt } = await draft({ calculatorEnabled: true, calculatorType: "SCIENTIFIC" });
    const { user, view, T } = await learnerView(admin, assessment.id, batch.id, startAt);
    expect(view.assessment.calculator).toBe("SCIENTIFIC");
    // The attempt, its timer and its answers carry nothing calculator-related: reloading gives the same state.
    const again = await getMyAttempt(user, view.attempt.id, T);
    expect(again.attempt).toEqual(view.attempt);
    expect(again.responses).toEqual(view.responses);
    expect(Object.keys(await db.assessmentAttempt.findUniqueOrThrow({ where: { id: view.attempt.id } })).filter((k) => /calc/i.test(k))).toEqual([]);
  });
});
