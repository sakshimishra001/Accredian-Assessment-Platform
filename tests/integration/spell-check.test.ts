import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, getAssessment, publishAssessment, updateAssessment } from "@/server/services/assessments";
import { getMyAttempt, saveResponses, startOrResumeAttempt, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment } from "@/server/services/candidates";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { uploadAnswerFile } from "@/server/services/files";
import { assessmentInput, createActor, createReadyPaper, createAssessmentRow, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/* Spell check: an assessment setting from the server, delivered to the learner's exam. */

beforeEach(resetDatabase);
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

async function exam(settings: Record<string, unknown> = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        questions: [
          mcqSingle({ text: "Pick one" }),
          { ...shortAnswer({ text: "Explain and attach." }), response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false } },
        ],
      },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 1);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 120), ...settings }));
  return { admin, assessment, batch, startAt };
}

describe("spell check setting", () => {
  it("12: off by default — for new assessments and for existing rows", async () => {
    const { admin, assessment } = await exam();
    expect((await getAssessment(admin, assessment.id)).settings.spellCheckEnabled).toBe(false);
    const legacy = await createAssessmentRow({ createdById: admin.id });
    expect((await db.assessment.findUniqueOrThrow({ where: { id: legacy.id } })).spellCheckEnabled).toBe(false);
  });

  it("persists when turned on, survives a partial save and publishing; can't change once live", async () => {
    const { admin, assessment, batch, startAt } = await exam({ spellCheckEnabled: true });
    await updateAssessment(admin, assessment.id, { name: "Renamed" });
    expect((await getAssessment(admin, assessment.id)).settings.spellCheckEnabled).toBe(true);
    await publishAssessment(admin, assessment.id);
    await updateAssessment(admin, assessment.id, { spellCheckEnabled: false });
    await updateAssessment(admin, assessment.id, { spellCheckEnabled: true });
    expect((await getAssessment(admin, assessment.id)).settings.spellCheckEnabled).toBe(true);
    await assignBatchToAssessment(admin, assessment.id, batch.id);
    await expect(updateAssessment(admin, assessment.id, { spellCheckEnabled: false }, at(startAt, 5))).rejects.toThrow(/Spell check cannot be changed while the assessment is active/);
  });
});

describe("learner exam", () => {
  async function learner(settings: Record<string, unknown>) {
    const { admin, assessment, batch, startAt } = await exam(settings);
    await publishAssessment(admin, assessment.id);
    await assignBatchToAssessment(admin, assessment.id, batch.id);
    const [cred] = await issueExamCredentials(admin, assessment.id);
    const T = at(startAt, 5);
    const r = await authenticateExamCredential(cred.learner.email, cred.code, {}, T);
    if (!r.ok) throw new Error(r.reason);
    const user = (await validateSessionToken(r.token, T))!;
    const view = await startOrResumeAttempt(user, T);
    const written = view.sections.flatMap((s) => s.items as ExamQuestion[]).find((q) => q.response?.type === "TEXT_FILE")!;
    return { user, view, written, T };
  }

  it("1/2: the exam receives the setting from the server", async () => {
    expect((await learner({ spellCheckEnabled: false })).view.assessment.spellCheck).toBe(false);
    await resetDatabase();
    expect((await learner({ spellCheckEnabled: true })).view.assessment.spellCheck).toBe(true);
  });

  it("3/4/5/11: text + file answers work as before; text is saved exactly as typed (misspellings included) and the file is unaffected", async () => {
    const { user, view, written, T } = await learner({ spellCheckEnabled: true });
    await saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "Teh recieve  definately" }] }, at(T, 1));
    await uploadAnswerFile(user, view.attempt.id, written.assessmentQuestionId, { name: "w.csv", data: Buffer.from("a,b\n1,2\n") }, {}, at(T, 2));
    // The learner accepts a browser suggestion: the corrected text is just a normal edit.
    await saveResponses(user, view.attempt.id, { responses: [{ assessmentQuestionId: written.assessmentQuestionId, textAnswer: "The recieve  definately" }] }, at(T, 3));
    const reloaded = await getMyAttempt(user, view.attempt.id, at(T, 4));
    const r = reloaded.responses.find((x) => x.assessmentQuestionId === written.assessmentQuestionId)!;
    expect(r.textAnswer).toBe("The recieve  definately");
    expect(r.attachments.map((a) => a.file.fileName)).toEqual(["w.csv"]);
  });
});
