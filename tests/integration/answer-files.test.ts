import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { NotFoundError } from "@/lib/errors";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment } from "@/server/services/assessments";
import { getMyAttempt, saveResponses, startOrResumeAttempt, submitAttempt, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer } from "@/server/services/candidates";
import { finalizeEvaluation, getEvaluation, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { readFile, removeAnswerFile, uploadAnswerFile } from "@/server/services/files";
import { MemoryStorage, storage } from "@/server/storage";
import { assessmentInput, createActor, createReadyPaper, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * File upload as an answer (response types TEXT / FILE / TEXT_FILE), end to end against
 * assessment_test with in-memory storage: configuration, learner uploads through the upload route,
 * persistence across navigation and reloads, server-side checks at submission, access control and
 * examiner evaluation.
 */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => Promise.reject(new Error(`redirect:${url}`)) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const answerRoute = await import("@/app/api/attempts/[attemptId]/files/route");
const fileRoute = await import("@/app/api/files/[id]/route");

const store = storage() as MemoryStorage;
beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const MB = 1024 * 1024;
const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const CSV = Buffer.from("region,sales\nNorth,120\nSouth,95\n");
const CSV2 = Buffer.from("region,sales\nEast,80\n");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

/**
 * Q1 objective · Q2 text only · Q3 FILE (csv/xlsx, 1 MB, 1 file, required) · Q4 TEXT_FILE (pdf/csv,
 * 2 files, optional). Two learners take it; an examiner is assigned to the first.
 */
async function scenario() {
  const admin = await createActor(Role.ADMIN);
  const examiner = await createActor(Role.EXAMINER);
  const otherExaminer = await createActor(Role.EXAMINER);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        questions: [
          mcqSingle({ text: "Pick one" }),
          shortAnswer({ text: "Explain in words." }),
          { ...shortAnswer({ text: "Upload your workbook." }), response: { type: "FILE", allowedFileTypes: ["csv", "xlsx"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: true } },
          { ...shortAnswer({ text: "Explain and attach your workings." }), response: { type: "TEXT_FILE", allowedFileTypes: ["pdf", "csv"], maxFileSizeMb: 1, maxFiles: 2, fileRequired: false } },
        ],
      },
    ],
  });
  const batch = await createBatchWithLearners(course.id, 2);
  const startAt = hoursFromNow(1);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: paper.id, batchId: batch.id, startAt, endAt: at(startAt, 180), durationMinutes: 60, timingMode: "FULL_DURATION" }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, batch.id);
  const issued = (await issueExamCredentials(admin, assessment.id)).sort((x, y) => x.learner.name.localeCompare(y.learner.name));
  await assignExaminer(admin, assessment.id, [issued[0].candidateId], examiner.id);
  const T = at(startAt, 5);

  async function learner(i: number) {
    const r = await authenticateExamCredential(issued[i].learner.email, issued[i].code, {}, T);
    if (!r.ok) throw new Error(r.reason);
    const user = (await validateSessionToken(r.token, T))!;
    const view = await startOrResumeAttempt(user, T);
    const [mcq, text, file, both] = view.sections.flatMap((s) => s.items as ExamQuestion[]);
    return { user, token: r.token, attemptId: view.attempt.id, mcq, text, file, both };
  }
  return { admin, examiner, otherExaminer, assessment, T, learner };
}

type L = Awaited<ReturnType<Awaited<ReturnType<typeof scenario>>["learner"]>>;

/** Upload through the real route (multipart, same origin) as the learner. */
async function viaRoute(l: L, assessmentQuestionId: string, file: { name: string; data: Buffer }, replaceAttachmentId?: string) {
  jar.set(SESSION_COOKIE_NAME, l.token);
  const fd = new FormData();
  fd.set("assessmentQuestionId", assessmentQuestionId);
  if (replaceAttachmentId) fd.set("replaceAttachmentId", replaceAttachmentId);
  fd.set("file", new File([new Uint8Array(file.data)], file.name));
  const res = await answerRoute.POST(new Request(`http://localhost/api/attempts/${l.attemptId}/files`, { method: "POST", body: fd, headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } }), {
    params: Promise.resolve({ attemptId: l.attemptId }),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: { attachmentId: string; file: { id: string; fileName: string; sizeBytes: number } } } };
}
const getFile = (token: string, fileId: string) => {
  jar.set(SESSION_COOKIE_NAME, token);
  return fileRoute.GET(new Request(`http://localhost/api/files/${fileId}`), { params: Promise.resolve({ id: fileId }) });
};
const attachmentsOf = async (attemptId: string, assessmentQuestionId: string) =>
  db.answerAttachment.findMany({ where: { response: { attemptId, assessmentQuestionId } }, include: { file: { select: { id: true, fileName: true, sizeBytes: true, storageKey: true, uploadedById: true } } } });

// ===========================================================================
describe("response types", () => {
  it("1/14: text-only and text + file answers work; each part is independently editable", async () => {
    const { T, learner } = await scenario();
    const l = await learner(0);
    expect([l.text.response?.type, l.file.response?.type, l.both.response?.type]).toEqual(["TEXT", "FILE", "TEXT_FILE"]);
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.text.assessmentQuestionId, textAnswer: "Plain answer" }, { assessmentQuestionId: l.both.assessmentQuestionId, textAnswer: "My workings" }] }, at(T, 1));
    const up = await uploadAnswerFile(l.user, l.attemptId, l.both.assessmentQuestionId, { name: "workings.pdf", data: PDF }, {}, at(T, 2));
    // Editing the text keeps the file; removing the file keeps the text.
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.both.assessmentQuestionId, textAnswer: "My workings, revised" }] }, at(T, 3));
    expect(await attachmentsOf(l.attemptId, l.both.assessmentQuestionId)).toHaveLength(1);
    await removeAnswerFile(l.user, l.attemptId, up.attachmentId, at(T, 4));
    const r = await db.attemptResponse.findFirstOrThrow({ where: { attemptId: l.attemptId, assessmentQuestionId: l.both.assessmentQuestionId }, include: { _count: { select: { attachments: true } } } });
    expect(r).toMatchObject({ textAnswer: "My workings, revised", _count: { attachments: 0 } });
    // A text-only question takes no files.
    await expect(uploadAnswerFile(l.user, l.attemptId, l.text.assessmentQuestionId, { name: "x.csv", data: CSV }, {}, at(T, 5))).rejects.toThrow(/doesn’t accept file uploads/);
  });
});

describe("uploading", () => {
  it("2: a valid file uploads through the route; bytes go to storage, the database keeps the metadata and the link to attempt + question", async () => {
    const { learner } = await scenario();
    const l = await learner(0);
    const r = await viaRoute(l, l.file.assessmentQuestionId, { name: "workbook.csv", data: CSV });
    expect(r).toMatchObject({ status: 200, body: { ok: true, data: { file: { fileName: "workbook.csv", sizeBytes: CSV.length } } } });
    const [a] = await attachmentsOf(l.attemptId, l.file.assessmentQuestionId);
    expect(a.file).toMatchObject({ fileName: "workbook.csv", uploadedById: l.user.id });
    expect(store.keys()).toContain(a.file.storageKey);
    expect(a.file.storageKey).toMatch(/^answer\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.csv$/);
    expect(Object.keys(await db.storedFile.findUniqueOrThrow({ where: { id: a.file.id } }))).not.toContain("data");
  });

  it("3/4: an unsupported type, disguised content, an oversized file and too many files are rejected", async () => {
    const { learner } = await scenario();
    const l = await learner(0);
    expect(await viaRoute(l, l.file.assessmentQuestionId, { name: "report.pdf", data: PDF })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/isn’t accepted here/) } });
    expect(await viaRoute(l, l.file.assessmentQuestionId, { name: "fake.csv", data: PNG })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/doesn’t match/) } });
    const big = Buffer.concat([Buffer.from("a,b\n"), Buffer.alloc(1.5 * MB, "1,2\n")]);
    expect(await viaRoute(l, l.file.assessmentQuestionId, { name: "big.csv", data: big })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/too large.*1 MB/) } });
    expect(await viaRoute(l, l.file.assessmentQuestionId, { name: "one.csv", data: CSV })).toMatchObject({ status: 200 });
    expect(await viaRoute(l, l.file.assessmentQuestionId, { name: "two.csv", data: CSV2 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/takes one file/) } });
    expect(await attachmentsOf(l.attemptId, l.file.assessmentQuestionId)).toHaveLength(1);
  });

  it("7/8: replace swaps the file (the old bytes are deleted); remove deletes it", async () => {
    const { learner } = await scenario();
    const l = await learner(0);
    const first = (await viaRoute(l, l.file.assessmentQuestionId, { name: "v1.csv", data: CSV })).body.data!;
    const oldKey = (await attachmentsOf(l.attemptId, l.file.assessmentQuestionId))[0].file.storageKey;
    const second = (await viaRoute(l, l.file.assessmentQuestionId, { name: "v2.csv", data: CSV2 }, first.attachmentId)).body.data!;
    const now = await attachmentsOf(l.attemptId, l.file.assessmentQuestionId);
    expect(now.map((a) => a.file.fileName)).toEqual(["v2.csv"]);
    expect(store.keys()).not.toContain(oldKey);
    expect(await db.storedFile.count({ where: { id: first.file.id } })).toBe(0);

    await removeAnswerFile(l.user, l.attemptId, second.attachmentId);
    expect(await attachmentsOf(l.attemptId, l.file.assessmentQuestionId)).toHaveLength(0);
    expect(await db.storedFile.count({ where: { id: second.file.id } })).toBe(0);
  });

  it("9/10: the file stays with its question across navigation (other answers saved) and a reload of the same attempt", async () => {
    const { T, learner } = await scenario();
    const l = await learner(0);
    await viaRoute(l, l.file.assessmentQuestionId, { name: "workbook.csv", data: CSV });
    // Navigate: answer other questions.
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.mcq.assessmentQuestionId, selectedOptionIds: [l.mcq.options[0].id] }, { assessmentQuestionId: l.text.assessmentQuestionId, textAnswer: "Elsewhere" }] }, at(T, 2));
    // Reload / reconnect: the same attempt comes back with the file attached to the same question.
    for (const view of [await getMyAttempt(l.user, l.attemptId, at(T, 3)), await startOrResumeAttempt(l.user, at(T, 4))]) {
      expect(view.attempt.id).toBe(l.attemptId);
      const r = view.responses.find((x) => x.assessmentQuestionId === l.file.assessmentQuestionId)!;
      expect(r.attachments.map((a) => a.file.fileName)).toEqual(["workbook.csv"]);
    }
    expect(await db.assessmentAttempt.count({ where: { learnerId: l.user.id } })).toBe(1);
  });
});

// ===========================================================================
describe("final submission (server-side)", () => {
  it("5/6: a missing required file blocks submission; a missing optional file doesn't", async () => {
    const { T, learner } = await scenario();
    const l = await learner(0);
    await expect(submitAttempt(l.user, l.attemptId, {}, at(T, 5))).rejects.toThrow(/Upload the required file for Q3/);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).status).toBe("IN_PROGRESS");
    await viaRoute(l, l.file.assessmentQuestionId, { name: "workbook.csv", data: CSV });
    // Q4 (optional file) has none: submission goes through.
    expect(await submitAttempt(l.user, l.attemptId, {}, at(T, 6))).toMatchObject({ status: "SUBMITTED" });
  });

  it("re-checks every uploaded file against the question's rules at submission", async () => {
    const { T, learner } = await scenario();
    const l = await learner(0);
    await viaRoute(l, l.file.assessmentQuestionId, { name: "workbook.csv", data: CSV });
    // Simulate data that no longer meets the configuration (e.g. a stale or tampered row).
    const pq = await db.assessmentQuestion.findUniqueOrThrow({ where: { id: l.file.assessmentQuestionId }, select: { paperQuestionId: true } });
    await db.paperQuestion.update({ where: { id: pq.paperQuestionId! }, data: { allowedFileTypes: ["xlsx"] } });
    await expect(submitAttempt(l.user, l.attemptId, {}, at(T, 5))).rejects.toThrow(/Q3: workbook\.csv isn’t an accepted type/);
    await db.paperQuestion.update({ where: { id: pq.paperQuestionId! }, data: { allowedFileTypes: ["csv", "xlsx"], maxFileSizeMb: 1 } });
    await db.storedFile.updateMany({ where: { fileName: "workbook.csv" }, data: { sizeBytes: 2 * MB } });
    await expect(submitAttempt(l.user, l.attemptId, {}, at(T, 6))).rejects.toThrow(/larger than 1 MB/);
  });
});

// ===========================================================================
describe("access and evaluation", () => {
  it("11: a learner can't read, replace or remove another learner's answer file", async () => {
    const { learner } = await scenario();
    const a = await learner(0);
    const b = await learner(1);
    const up = (await viaRoute(a, a.file.assessmentQuestionId, { name: "mine.csv", data: CSV })).body.data!;
    expect((await getFile(b.token, up.file.id)).status).toBe(404);
    await expect(readFile(b.user, up.file.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await viaRoute(b, a.file.assessmentQuestionId, { name: "x.csv", data: CSV }, up.attachmentId)).status).toBe(404);
    await expect(removeAnswerFile(b.user, a.attemptId, up.attachmentId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getFile(a.token, up.file.id)).status).toBe(200);
  });

  it("12/13: the assigned examiner sees, previews and downloads the file and evaluates normally; another examiner can't", async () => {
    const { T, examiner, otherExaminer, learner } = await scenario();
    const l = await learner(0);
    await saveResponses(l.user, l.attemptId, { responses: [{ assessmentQuestionId: l.text.assessmentQuestionId, textAnswer: "Words" }] }, at(T, 1));
    const up = (await viaRoute(l, l.file.assessmentQuestionId, { name: "workbook.csv", data: CSV })).body.data!;
    await submitAttempt(l.user, l.attemptId, {}, at(T, 5));

    const ev = await getEvaluation(examiner as SessionUser, l.attemptId);
    const q3 = ev.questions.find((q) => q.assessmentQuestionId === l.file.assessmentQuestionId)!;
    expect(q3.answer.files).toEqual([expect.objectContaining({ id: up.file.id, fileName: "workbook.csv", extension: "csv", sizeBytes: CSV.length })]);
    expect(q3.needsMarks).toBe(true);
    const read = await readFile(examiner as SessionUser, up.file.id);
    expect(read.data.equals(CSV)).toBe(true);
    await expect(readFile(otherExaminer as SessionUser, up.file.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getEvaluation(otherExaminer as SessionUser, l.attemptId)).rejects.toThrow();

    // Scoring works as before: marks + feedback for the file answer and the written one, then finalize.
    await saveEvaluation(examiner as SessionUser, l.attemptId, {
      marks: [
        { assessmentQuestionId: l.file.assessmentQuestionId, awardedMarks: 4, comment: "Clean workbook" },
        { assessmentQuestionId: l.text.assessmentQuestionId, awardedMarks: 3 },
      ],
    });
    await finalizeEvaluation(examiner as SessionUser, l.attemptId);
    const r = await db.attemptResponse.findFirstOrThrow({ where: { attemptId: l.attemptId, assessmentQuestionId: l.file.assessmentQuestionId } });
    expect(r).toMatchObject({ examinerComment: "Clean workbook" });
    expect(r.awardedMarks?.toNumber()).toBe(4);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: l.attemptId } })).evaluationStatus).toBe("COMPLETED");
  });
});
