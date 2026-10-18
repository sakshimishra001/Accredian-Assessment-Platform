import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { renderTemplate, SAMPLE_VALUES } from "@/lib/communication/templates";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { emailProvider, TestEmailProvider } from "@/server/email";
import { createAssessment, syncTimeBasedStatuses } from "@/server/services/assessments";
import { getMyAttempt, startOrResumeAttempt, submitAttempt, type ExamQuestion } from "@/server/services/attempts";
import { getAssessmentCommunication, listCommunicationLog } from "@/server/services/communication";
import { getEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import {
  addPaperQuestion,
  addSection,
  createQuestionPaper,
  getQuestionPaper,
} from "@/server/services/question-papers";
import { deliverPendingEmails } from "@/server/email/outbox";
import { MemoryStorage, storage } from "@/server/storage";
import { assessmentInput, createBatchWithLearners, createCourse, createUser, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * Files (supporting materials, learner answer uploads, authorised downloads) and communication
 * (templates, assessment settings, sending through the test provider, history) — end to end through
 * the route handlers and server actions, against assessment_test, in-memory storage and the test
 * email provider (nothing is written to disk and no email is sent).
 */

// --- Next.js request APIs: a cookie jar holding the signed-in user's session ----------------
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const materialsRoute = await import("@/app/api/files/materials/route");
const answerRoute = await import("@/app/api/attempts/[attemptId]/files/route");
const fileRoute = await import("@/app/api/files/[id]/route");
const assessmentActions = await import("@/server/actions/assessments");
const attemptActions = await import("@/server/actions/attempts");
const paperActions = await import("@/server/actions/question-papers");
const communication = await import("@/server/actions/communication");
const results = await import("@/server/actions/results");

const mail = emailProvider() as TestEmailProvider;
const store = storage() as MemoryStorage;

beforeEach(async () => {
  jar.clear();
  mail.messages.length = 0;
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const ok = <T,>(r: { ok: boolean; data?: T; error?: string; fieldErrors?: unknown }) => {
  if (!r.ok) throw new Error(`action failed: ${r.error} ${JSON.stringify(r.fieldErrors ?? {})}`);
  return r.data as T;
};
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));

// --- tiny valid files ----------------------------------------------------------------------
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const CSV = Buffer.from("region,sales\nNorth,120\nSouth,95\n");

async function signIn(user: { id: string }) {
  jar.set(SESSION_COOKIE_NAME, (await createSession(user.id)).token);
}
function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer; type?: string }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set("file", new File([new Uint8Array(file.data)], file.name, { type: file.type ?? "application/octet-stream" }));
  // What a same-origin browser upload sends.
  return new Request("http://localhost/api/upload", { method: "POST", body: fd, headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } });
}
async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown> & { file: { id: string } } } };
}
const getFile = (fileId: string, inline = false) => fileRoute.GET(new Request(`http://localhost/api/files/${fileId}${inline ? "?inline=1" : ""}`), { params: Promise.resolve({ id: fileId }) });

async function staff(role: Role, name: string): Promise<SessionUser> {
  const u = await createUser({ role, name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.com` });
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

/**
 * A draft paper: Section A (one MCQ), Section B (a written question answered with a file:
 * pdf/csv, max 1 MB, one file, required). Returns the paper and item ids.
 */
async function draftPaper(admin: SessionUser, courseId: string) {
  const paper = await createQuestionPaper(admin, { name: "Data Analysis Final", courseId });
  const a = await addSection(admin, paper.id, { title: "Section A" });
  await addPaperQuestion(admin, a.id, mcqSingle({ text: "Pick the prime" }));
  const b = await addSection(admin, paper.id, { title: "Section B" });
  const written = await addPaperQuestion(admin, b.id, {
    ...shortAnswer({ text: "Analyse the attached sales data and upload your workbook." }),
    response: { type: "TEXT_FILE", allowedFileTypes: ["pdf", "csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: true },
  });
  return { paper, writtenItemId: written.id };
}

/** A saved paper (with a material on the written question) → assessment open now → two learners with exam sessions. */
async function openExam() {
  const admin = await staff(Role.ADMIN, "Admin Person");
  const course = await createCourse();
  const { paper, writtenItemId } = await draftPaper(admin, course.id);
  await signIn(admin);
  const material = await json(await materialsRoute.POST(multipart({ paperQuestionId: writtenItemId, description: "Raw data" }, { name: "Sales Data.csv", data: CSV, type: "text/csv" })));
  expect(material.status).toBe(200);

  const batch = await createBatchWithLearners(course.id, 2);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { name: "Data Final", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(1), endAt: hoursFromNow(4) }));
  ok(await assessmentActions.publishAssessmentAction(assessment.id));
  await db.assessment.update({ where: { id: assessment.id }, data: { startAt: hoursFromNow(-1) } });
  await syncTimeBasedStatuses(new Date(), assessment.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const sessions = [];
  for (const c of issued.sort((x, y) => x.learner.name.localeCompare(y.learner.name))) {
    const r = await authenticateExamCredential(c.learner.email, c.code);
    if (!r.ok) throw new Error(r.reason);
    const user = (await validateSessionToken(r.token))!;
    const view = await startOrResumeAttempt(user);
    const written = view.sections.flatMap((s) => s.items).find((i): i is ExamQuestion => i.kind === "question" && i.response?.type === "TEXT_FILE")!;
    sessions.push({ user, token: r.token, attemptId: view.attempt.id, written });
  }
  jar.clear();
  return { admin, paper, assessment, materialFileId: material.body.data!.file.id, learners: sessions };
}

const asLearner = (l: { token: string }) => jar.set(SESSION_COOKIE_NAME, l.token);
const upload = (attemptId: string, fields: Record<string, string>, file: { name: string; data: Buffer; type?: string }) =>
  answerRoute.POST(multipart(fields, file), { params: Promise.resolve({ attemptId }) }).then(json);

// ===========================================================================
describe("supporting materials", () => {
  it("an admin attaches a material; its metadata persists and the bytes are in storage", async () => {
    const admin = await staff(Role.ADMIN, "Admin Person");
    const { paper, writtenItemId } = await draftPaper(admin, (await createCourse()).id);
    await signIn(admin);

    const res = await json(await materialsRoute.POST(multipart({ paperQuestionId: writtenItemId, description: "Market chart" }, { name: "Market Share.png", data: PNG, type: "image/png" })));
    expect(res).toMatchObject({ status: 200, body: { ok: true, data: { description: "Market chart", file: { fileName: "Market Share.png", extension: "png", mimeType: "image/png" } } } });

    const row = await db.storedFile.findFirstOrThrow({ include: { materials: true } });
    expect(row).toMatchObject({ purpose: "MATERIAL", sizeBytes: PNG.length, storageDriver: "memory", uploadedById: admin.id, materials: [{ paperQuestionId: writtenItemId, position: 1 }] });
    expect(row.storageKey).toMatch(/^material\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(store.keys()).toContain(row.storageKey);

    // A fresh read of the paper shows it on the question.
    const fresh = await getQuestionPaper(admin, paper.id);
    const item = fresh.sections[1].items[0];
    expect(item.kind === "question" && item.materials).toEqual([{ id: expect.any(String), description: "Market chart", file: { id: row.id, fileName: "Market Share.png", extension: "png", sizeBytes: PNG.length } }]);
    expect(item.kind === "question" && item.response).toEqual({ type: "TEXT_FILE", allowedFileTypes: ["pdf", "csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: true });

    // Removing it deletes the record and the stored object.
    ok(await paperActions.removeMaterialAction(paper.id, (item.kind === "question" && item.materials[0].id) as string));
    expect(await db.storedFile.count()).toBe(0);
    expect(store.keys()).not.toContain(row.storageKey);
  });

  it("refuses wrong types, disguised files, non-admins and papers already used by an assessment", async () => {
    const admin = await staff(Role.ADMIN, "Admin Person");
    const course = await createCourse();
    const { paper, writtenItemId } = await draftPaper(admin, course.id);
    const post = (file: { name: string; data: Buffer }) => materialsRoute.POST(multipart({ paperQuestionId: writtenItemId }, file)).then(json);

    jar.clear();
    expect((await post({ name: "chart.png", data: PNG })).status).toBe(401);
    for (const role of [Role.EXAMINER, Role.REVIEWER]) {
      await signIn(await staff(role, `${role} Person`));
      expect((await post({ name: "chart.png", data: PNG })).status).toBe(403);
    }

    await signIn(admin);
    expect(await post({ name: "tool.exe", data: Buffer.from("MZ...") })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/isn’t accepted/) } });
    // A "PDF" whose content isn't a PDF (the browser's MIME type is never trusted).
    expect(await post({ name: "report.pdf", data: Buffer.from("<html><script>alert(1)</script></html>") })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/doesn’t match/) } });
    expect(await post({ name: "x.svg", data: Buffer.from('<svg onload="alert(1)"></svg>') })).toMatchObject({ status: 400 });
    expect((await materialsRoute.POST(multipart({ paperQuestionId: "missing" }, { name: "a.png", data: PNG })).then(json)).status).toBe(404);

    // Once an assessment uses the paper it can't change (create a new version instead).
    await createAssessment(admin, assessmentInput(course.id, { name: "Uses the paper", type: "MIXED", paperId: paper.id }));
    expect((await post({ name: "chart.png", data: PNG })).status).toBe(409);
    expect(await db.storedFile.count()).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it("new paper versions keep the materials and response settings", async () => {
    const { admin, paper } = await openExam();
    await signIn(admin);
    const { id } = ok(await paperActions.createRevisionAction(paper.id));
    const v2 = await getQuestionPaper(admin, id);
    const item = v2.sections[1].items[0];
    expect(item.kind === "question" && item.materials.map((m) => m.file.fileName)).toEqual(["Sales Data.csv"]);
    expect(item.kind === "question" && item.response.type).toBe("TEXT_FILE");
  });
});

// ===========================================================================
describe("learner answer uploads", () => {
  it("uploads a permitted file to the learner's own answer; it counts as answered and goes to the examiner", async () => {
    const { learners } = await openExam();
    const [me] = learners;
    asLearner(me);
    const res = await upload(me.attemptId, { assessmentQuestionId: me.written.assessmentQuestionId }, { name: "analysis.csv", data: CSV, type: "text/csv" });
    expect(res).toMatchObject({ status: 200, body: { ok: true, data: { attachmentId: expect.any(String), file: { fileName: "analysis.csv", extension: "csv" } } } });

    const view = await getMyAttempt(me.user, me.attemptId);
    expect(view.responses.find((r) => r.assessmentQuestionId === me.written.assessmentQuestionId)?.attachments).toEqual([
      { id: res.body.data!.attachmentId, file: { id: res.body.data!.file.id, fileName: "analysis.csv", extension: "csv", sizeBytes: CSV.length } },
    ]);
    // The exam view carries the response rules and the material — never more.
    expect(me.written.response).toEqual({ type: "TEXT_FILE", allowedFileTypes: ["pdf", "csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: true });
    expect(me.written.materials.map((m) => m.fileName)).toEqual(["Sales Data.csv"]);

    // File only (no text) → the answer needs examiner marks.
    await submitAttempt(me.user, me.attemptId);
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: me.attemptId } })).evaluationStatus).toBe("PENDING");
  });

  it("rejects types the question doesn't accept, disguised content and oversized files", async () => {
    const { learners } = await openExam();
    const [me] = learners;
    asLearner(me);
    const q = { assessmentQuestionId: me.written.assessmentQuestionId };
    expect(await upload(me.attemptId, q, { name: "chart.png", data: PNG })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Allowed: \.pdf, \.csv/) } });
    expect(await upload(me.attemptId, q, { name: "fake.pdf", data: CSV })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/doesn’t match/) } });
    expect(await upload(me.attemptId, q, { name: "big.csv", data: Buffer.alloc(1024 * 1024 + 1, "a") })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/too large/) } });
    // An objective question takes no files.
    const mcq = (await getMyAttempt(me.user, me.attemptId)).sections[0].items[0] as ExamQuestion;
    expect(await upload(me.attemptId, { assessmentQuestionId: mcq.assessmentQuestionId }, { name: "a.csv", data: CSV })).toMatchObject({ status: 400 });
    expect(await db.storedFile.count({ where: { purpose: "ANSWER" } })).toBe(0);
  });

  it("a learner can't upload to, replace or remove files of another learner's attempt", async () => {
    const { learners } = await openExam();
    const [a, b] = learners;
    asLearner(a);
    const mine = await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "a.csv", data: CSV });
    asLearner(b);
    expect((await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "b.csv", data: CSV })).status).toBe(404);
    expect((await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId, replaceAttachmentId: mine.body.data!.attachmentId as string }, { name: "b.csv", data: CSV })).status).toBe(404);
    expect(await attemptActions.removeAnswerFileAction(a.attemptId, mine.body.data!.attachmentId as string)).toEqual({ ok: false, error: "Attempt not found." });
    // Staff can't use the learner upload route.
    await signIn(await staff(Role.ADMIN, "Other Admin"));
    expect((await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "c.csv", data: CSV })).status).toBe(403);
    expect(await db.answerAttachment.count()).toBe(1);
  });

  it("replaces and removes files, cleaning up the stored objects", async () => {
    const { learners } = await openExam();
    const [me] = learners;
    asLearner(me);
    const q = { assessmentQuestionId: me.written.assessmentQuestionId };
    const first = await upload(me.attemptId, q, { name: "v1.csv", data: CSV });
    // One file allowed: a second needs to replace the first.
    expect(await upload(me.attemptId, q, { name: "v2.csv", data: CSV })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Replace or remove/) } });

    const firstKey = (await db.storedFile.findUniqueOrThrow({ where: { id: first.body.data!.file.id } })).storageKey;
    const second = await upload(me.attemptId, { ...q, replaceAttachmentId: first.body.data!.attachmentId as string }, { name: "v2.pdf", data: PDF });
    expect(second.status).toBe(200);
    expect(await db.storedFile.findUnique({ where: { id: first.body.data!.file.id } })).toBeNull();
    expect(store.keys()).not.toContain(firstKey);
    expect((await db.answerAttachment.findMany({ include: { file: true } })).map((x) => x.file.fileName)).toEqual(["v2.pdf"]);

    ok(await attemptActions.removeAnswerFileAction(me.attemptId, second.body.data!.attachmentId as string));
    expect(await db.answerAttachment.count()).toBe(0);
    expect(await db.storedFile.count({ where: { purpose: "ANSWER" } })).toBe(0);
  });

  it("a required file blocks manual submission; submitted and expired attempts refuse changes", async () => {
    const { learners } = await openExam();
    const [a, b] = learners;
    asLearner(a);
    expect(await attemptActions.submitAttemptAction(a.attemptId)).toMatchObject({ ok: false, error: expect.stringMatching(/Upload the required file for Q2/) });

    const up = await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "a.csv", data: CSV });
    ok(await attemptActions.submitAttemptAction(a.attemptId));
    expect(await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "late.csv", data: CSV })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already been submitted/) } });
    expect(await attemptActions.removeAnswerFileAction(a.attemptId, up.body.data!.attachmentId as string)).toMatchObject({ ok: false, error: expect.stringMatching(/already been submitted/) });

    // Past the deadline: the attempt closes (auto-submit) instead of accepting the file.
    await db.assessmentAttempt.update({ where: { id: b.attemptId }, data: { startedAt: hoursFromNow(-3), deadlineAt: hoursFromNow(-2) } });
    asLearner(b);
    expect(await upload(b.attemptId, { assessmentQuestionId: b.written.assessmentQuestionId }, { name: "b.csv", data: CSV })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Time is up/) } });
    expect((await db.assessmentAttempt.findUniqueOrThrow({ where: { id: b.attemptId } })).status).toBe("AUTO_SUBMITTED");
    expect(await db.storedFile.count({ where: { purpose: "ANSWER" } })).toBe(1);
  });
});

// ===========================================================================
describe("file access", () => {
  it("only the owner, the assigned examiner and admins read an answer file; learners read their assessment's materials", async () => {
    const { admin, assessment, materialFileId, learners } = await openExam();
    const [a, b] = learners;
    asLearner(a);
    const up = await upload(a.attemptId, { assessmentQuestionId: a.written.assessmentQuestionId }, { name: "answer.csv", data: CSV });
    const answerFileId = up.body.data!.file.id;

    const res = await getFile(answerFileId, true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="answer.csv"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(CSV)).toBe(true);
    expect((await getFile(materialFileId)).status).toBe(200);

    asLearner(b);
    expect((await getFile(answerFileId)).status).toBe(404);
    expect((await getFile(materialFileId)).status).toBe(200);

    // Examiners: only for their assigned candidates' submitted attempts.
    const examiner = await staff(Role.EXAMINER, "Examiner One");
    const other = await staff(Role.EXAMINER, "Examiner Two");
    const candidate = await db.assessmentCandidate.findFirstOrThrow({ where: { assessmentId: assessment.id, learnerId: a.user.id } });
    await signIn(admin);
    ok(await results.assignExaminerAction(assessment.id, [candidate.id], examiner.id));
    await signIn(examiner);
    expect((await getFile(answerFileId)).status).toBe(404); // not submitted yet
    await submitAttempt(a.user, a.attemptId);
    expect((await getFile(answerFileId)).status).toBe(200);
    expect((await getFile(materialFileId)).status).toBe(200);
    expect((await getEvaluation(examiner, a.attemptId)).questions.find((q) => q.needsMarks)?.answer.files).toEqual([{ id: answerFileId, fileName: "answer.csv", extension: "csv", sizeBytes: CSV.length }]);
    await signIn(other);
    expect((await getFile(answerFileId)).status).toBe(404);
    expect((await getFile(materialFileId)).status).toBe(404);

    await signIn(admin);
    const download = await getFile(answerFileId);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    jar.clear();
    expect((await getFile(answerFileId)).status).toBe(401);
    expect((await getFile("not-a-file")).status).toBe(401);
  });
});

// ===========================================================================
const template = (over: Record<string, unknown> = {}) => ({
  name: "Exam Assignment",
  type: "ASSESSMENT",
  trigger: "On assessment publish",
  subject: "You’re assigned: {{assessment_name}}",
  body: "Hi {{learner_name}},\n\nYou have been assigned **{{assessment_name}}** on {{assessment_start_date}} at {{assessment_start_time}}.\n\n[Open the assessment]({{assessment_link}})",
  status: "ACTIVE",
  fromName: "Accredian Assessments",
  fromEmail: "Assessments@Example.com",
  replyTo: "",
  ...over,
});

describe("communication templates", () => {
  it("creates, updates and duplicates templates; a fresh read returns them", async () => {
    await signIn(await staff(Role.ADMIN, "Admin Person"));
    const { id } = ok(await communication.createTemplateAction(template()));
    ok(await communication.updateTemplateAction(id, { subject: "Assigned: {{assessment_name}}", replyTo: "help@example.com" }));
    const row = await db.communicationTemplate.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ name: "Exam Assignment", type: "ASSESSMENT", status: "ACTIVE", subject: "Assigned: {{assessment_name}}", fromEmail: "assessments@example.com", replyTo: "help@example.com", trigger: "On assessment publish" });

    expect(await communication.createTemplateAction(template())).toMatchObject({ ok: false, fieldErrors: { name: ["Name already in use"] } });
    const copy = ok(await communication.duplicateTemplateAction(id));
    expect(copy.name).toBe("Exam Assignment (Copy)");
    expect(await db.communicationTemplate.findUniqueOrThrow({ where: { id: copy.id } })).toMatchObject({ status: "DRAFT", subject: "Assigned: {{assessment_name}}" });
  });

  it("rejects variables that aren't in the allowlist", async () => {
    await signIn(await staff(Role.ADMIN, "Admin Person"));
    expect(await communication.createTemplateAction(template({ body: "Your password is {{exam_password}} and {{learner_name}}." }))).toMatchObject({
      ok: false,
      fieldErrors: { body: ["Unknown variable: {{exam_password}}"] },
    });
    expect(await communication.createTemplateAction(template({ subject: "{{constructor}} {{__proto__}}" }))).toMatchObject({ ok: false, fieldErrors: { subject: [expect.stringMatching(/Unknown variables/)] } });
    expect(await db.communicationTemplate.count()).toBe(0);
  });

  it("previews with the shared renderer: variables substituted, values escaped in HTML", () => {
    const r = renderTemplate(template(), { ...SAMPLE_VALUES, learner_name: "<script>alert(1)</script>" });
    expect(r.subject).toBe("You’re assigned: Data Science Final Assessment");
    expect(r.html).toContain("<strong>Data Science Final Assessment</strong>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain('<a href="https://assessments.example.com/a/ds-final">Open the assessment</a>');
    expect(renderTemplate({ subject: "x", body: "[click](javascript:alert(1))" }, {}).html).toContain('href="#"');
  });

  it("only admins manage templates and assessment communication", async () => {
    const admin = await staff(Role.ADMIN, "Admin Person");
    await signIn(admin);
    const { id } = ok(await communication.createTemplateAction(template()));
    for (const role of [Role.EXAMINER, Role.REVIEWER]) {
      await signIn(await staff(role, `${role} Person`));
      expect(await redirectOf(communication.updateTemplateAction(id, { subject: "Hijacked" }))).toBe("/forbidden");
      expect(await redirectOf(communication.createTemplateAction(template({ name: "Other" })))).toBe("/forbidden");
      expect(await redirectOf(communication.saveAssessmentCommunicationAction("any", {}))).toBe("/forbidden");
    }
    jar.clear();
    expect(await redirectOf(communication.duplicateTemplateAction(id))).toBe("/login");
    expect((await db.communicationTemplate.findUniqueOrThrow({ where: { id } })).subject).toBe("You’re assigned: {{assessment_name}}");
  });
});

// ===========================================================================
describe("assessment communication", () => {
  async function setup() {
    const admin = await staff(Role.ADMIN, "Admin Person");
    await signIn(admin);
    const assignment = ok(await communication.createTemplateAction(template()));
    const result = ok(await communication.createTemplateAction(template({ name: "Result Published", type: "RESULTS", subject: "Results for {{assessment_name}}", body: "Hi {{learner_name}}, your result is out." })));
    const draft = ok(await communication.createTemplateAction(template({ name: "Draft Reminder", type: "REMINDER", status: "DRAFT" })));
    const course = await createCourse();
    const batch = await createBatchWithLearners(course.id, 2);
    const { paper } = await draftPaper(admin, course.id);
    const assessment = await createAssessment(admin, assessmentInput(course.id, { name: "Data Final", type: "MIXED", paperId: paper.id, batchId: batch.id, startAt: hoursFromNow(48), endAt: hoursFromNow(51) }));
    return { admin, assessment, templates: { assignment: assignment.id, result: result.id, draft: draft.id } };
  }
  const settings = (over: Record<string, Record<string, unknown>> = {}) => ({
    ASSIGNMENT: { enabled: true, templateId: "", ...over.ASSIGNMENT },
    REMINDER: { enabled: false, templateId: "", reminderTiming: "H24", reminderAt: "", ...over.REMINDER },
    STARTING_SOON: { enabled: false, templateId: "", ...over.STARTING_SOON },
    RESCHEDULED: { enabled: false, templateId: "", ...over.RESCHEDULED },
    CANCELLED: { enabled: false, templateId: "", ...over.CANCELLED },
    RESULT_PUBLISHED: { enabled: false, templateId: "", ...over.RESULT_PUBLISHED },
  });

  it("shows defaults, then persists the configuration with overrides and a custom reminder", async () => {
    const { admin, assessment, templates } = await setup();
    const before = await getAssessmentCommunication(admin, assessment.id);
    expect(before.settings.find((s) => s.event === "ASSIGNMENT")).toMatchObject({ enabled: true, templateId: templates.assignment, isDefault: true });

    const remindAt = new Date(Date.now() + 24 * 3600_000 + 330 * 60_000).toISOString().slice(0, 16);
    ok(
      await communication.saveAssessmentCommunicationAction(
        assessment.id,
        settings({
          ASSIGNMENT: { templateId: templates.assignment, overrideSubject: "Your {{assessment_name}} is ready" },
          REMINDER: { enabled: true, templateId: templates.assignment, reminderTiming: "CUSTOM", reminderAt: remindAt },
          RESULT_PUBLISHED: { enabled: true, templateId: templates.result },
        }),
      ),
    );
    const after = await getAssessmentCommunication(admin, assessment.id);
    expect(after.settings.find((s) => s.event === "ASSIGNMENT")).toMatchObject({ enabled: true, overrideSubject: "Your {{assessment_name}} is ready", isDefault: false });
    expect(after.settings.find((s) => s.event === "REMINDER")).toMatchObject({ enabled: true, reminderTiming: "CUSTOM", reminderAt: expect.any(Date) });
    expect(await db.assessmentCommunicationSetting.count({ where: { assessmentId: assessment.id } })).toBe(6);
  });

  it("validates templates, variables and the reminder time", async () => {
    const { assessment, templates } = await setup();
    expect(await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { templateId: "" } }))).toMatchObject({ ok: false, fieldErrors: { "ASSIGNMENT.templateId": ["Choose a template"] } });
    expect(await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { templateId: templates.draft } }))).toMatchObject({ ok: false, fieldErrors: { "ASSIGNMENT.templateId": ["Only active templates can be used"] } });
    expect(await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { templateId: templates.assignment, overrideBody: "{{secret}}" } }))).toMatchObject({ ok: false });
    expect(
      await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { templateId: templates.assignment }, REMINDER: { enabled: true, templateId: templates.assignment, reminderTiming: "CUSTOM", reminderAt: "2030-01-01T10:00" } })),
    ).toMatchObject({ ok: false, fieldErrors: { "REMINDER.reminderAt": ["The reminder must be before the assessment starts"] } });
    expect(await db.assessmentCommunicationSetting.count()).toBe(0);
  });

  it("publishing queues the assignment emails (the request sends nothing); the outbox worker delivers them through the test provider", async () => {
    const { assessment, templates } = await setup();
    ok(await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { templateId: templates.assignment }, RESULT_PUBLISHED: { enabled: true, templateId: templates.result } })));
    ok(await assessmentActions.publishAssessmentAction(assessment.id));

    // The admin request only recorded the emails.
    expect(mail.messages).toHaveLength(0);
    expect((await db.communicationLog.findMany({ select: { status: true } })).map((r) => r.status)).toEqual(["PENDING", "PENDING"]);
    expect(await deliverPendingEmails()).toMatchObject({ claimed: 2, notDelivered: 2 });

    expect(mail.messages).toHaveLength(2);
    expect(mail.messages[0]).toMatchObject({ from: { name: "Accredian Assessments", email: "assessments@example.com" }, subject: "You’re assigned: Data Final" });
    expect(mail.messages[0].html).toContain("<strong>Data Final</strong>");

    const admin = (await db.user.findFirstOrThrow({ where: { role: "ADMIN" } })) as unknown as SessionUser;
    const history = await listCommunicationLog(admin, { assessmentId: assessment.id });
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.status === "NOT_DELIVERED" && h.provider === "test" && h.event === "ASSIGNMENT" && h.template?.id === templates.assignment)).toBe(true);
    expect(await db.communicationLog.count({ where: { status: "SENT" } })).toBe(0);
  });

  it("existing lifecycle stays intact: no template → publish still works and nothing is logged; cancel/reschedule are recorded when on", async () => {
    const { assessment, templates } = await setup();
    ok(await communication.saveAssessmentCommunicationAction(assessment.id, settings({ ASSIGNMENT: { enabled: false } , CANCELLED: { enabled: true, templateId: templates.assignment }, RESCHEDULED: { enabled: true, templateId: templates.assignment } })));
    ok(await assessmentActions.publishAssessmentAction(assessment.id));
    expect(await db.communicationLog.count()).toBe(0);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("SCHEDULED");

    // Moving the window of a scheduled assessment → Rescheduled; back to draft → Cancelled.
    const start = new Date(Date.now() + 72 * 3600_000 + 330 * 60_000).toISOString().slice(0, 16);
    const end = new Date(Date.now() + 75 * 3600_000 + 330 * 60_000).toISOString().slice(0, 16);
    ok(await assessmentActions.saveAssessmentAction(assessment.id, { startAt: start, endAt: end }));
    ok(await assessmentActions.moveAssessmentToDraftAction(assessment.id));
    expect((await db.communicationLog.findMany({ select: { event: true } })).map((r) => r.event).sort()).toEqual(["CANCELLED", "CANCELLED", "RESCHEDULED", "RESCHEDULED"]);
    expect((await db.assessment.findUniqueOrThrow({ where: { id: assessment.id } })).status).toBe("DRAFT");
  });
});
