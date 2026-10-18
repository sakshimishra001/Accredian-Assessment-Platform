import { writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { AuditAction } from "@/server/audit";
import { authenticateExamCredential } from "@/server/auth/exam-login";
import { createSession, validateSessionToken, type SessionUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment, publishAssessment, transitionAssessment } from "@/server/services/assessments";
import { terminateAttempt } from "@/server/services/attempt-termination";
import { saveResponses, startOrResumeAttempt, submitAttempt, type AttemptView, type ExamQuestion } from "@/server/services/attempts";
import { assignBatchToAssessment, assignExaminer, listCandidates } from "@/server/services/candidates";
import { finalizeEvaluation, getEvaluation, saveEvaluation } from "@/server/services/evaluations";
import { issueExamCredentials } from "@/server/services/exam-credentials";
import { uploadAnswerFile } from "@/server/services/files";
import { assessmentResultsCsv, attemptReport } from "@/server/services/reports";
import { getAttemptResult, getMyResult, listAssessmentResults } from "@/server/services/results";
import { assessmentInput, createActor, createReadyPaper, createAssessmentRow, createBatchWithLearners, createCourse, hoursFromNow, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * D3 — result downloads: the candidate result PDF, the detailed evaluation PDF and the assessment
 * results CSV, through the route handlers and the report service. The PDFs' drawn text is read back
 * (content streams inflated) so the tests check what the reader sees, not just that a file exists.
 */

// --- Next.js request APIs: the route handlers read the session cookie ----------------------
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
const attemptRoute = await import("@/app/api/reports/attempts/[attemptId]/[kind]/route");
const assessmentRoute = await import("@/app/api/reports/assessments/[id]/results/route");

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const at = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);
const questionsOf = (v: AttemptView) => v.sections.flatMap((s) => s.items).filter((i): i is ExamQuestion => i.kind === "question");

/** For manual inspection: REPORT_DUMP_DIR=<dir> keeps the generated files. */
function dump(name: string, data: Uint8Array) {
  if (process.env.REPORT_DUMP_DIR) writeFileSync(path.join(process.env.REPORT_DUMP_DIR, name), data);
}

async function signIn(user: SessionUser) {
  jar.set(SESSION_COOKIE_NAME, (await createSession(user.id)).token);
}
const getAttemptReport = (attemptId: string, kind: string) => attemptRoute.GET(new Request(`http://localhost/api/reports/attempts/${attemptId}/${kind}`), { params: Promise.resolve({ attemptId, kind }) } as never);
const getResultsCsv = (id: string) => assessmentRoute.GET(new Request(`http://localhost/api/reports/assessments/${id}/results`), { params: Promise.resolve({ id }) } as never);

// WinAnsi 0x80–0x9F (the rest of the standard fonts' encoding is Latin-1).
const WIN_ANSI: Record<number, string> = { 0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ" };
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join("");

/** The text drawn in a PDF, page by page (standard-font hex strings decoded from WinAnsi). */
function pdfText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    let content: string;
    try {
      content = inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(winAnsi(t[1]));
  }
  return out.join("\n");
}

/** RFC 4180 parse (quotes, doubled quotes, CRLF). */
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  return rows;
}

const LONG = `First paragraph — “quoted”, naïve café, ≤ 5 and ≥ 2, 你好.\n\n${"Churn features include tenure, usage, support tickets and plan changes. ".repeat(160)}\nUnbrokenTokenWithoutSpaces${"x".repeat(400)}`;

/**
 * Max 13: Q1 MCQ (2, −0.5), Q2 True/False (1), Q3 written answer + file (10), passing marks 6.
 * Batch X (examiner e1): Asha 11 (pass, with a file and feedback), Bilal 2.5 (pending unless finalized),
 * Chen terminated. Batch Y (examiner e2): Divya 2 (objective only), Esha never started.
 */
async function scenario(settings: Record<string, unknown> = {}, { finalize = true } = {}) {
  const admin = await createActor(Role.ADMIN);
  const course = await createCourse();
  const paper = await createReadyPaper(admin, course.id, {
    sections: [
      {
        title: "Objective",
        questions: [
          mcqSingle({ text: "Which metric is TP / (TP + FN)?", marks: 2, negativeMarks: 0.5 }),
          mcqSingle({ text: "Precision is at most 1", type: "TRUE_FALSE", marks: 1, negativeMarks: 0, options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }] }),
        ],
      },
      {
        title: "Case study",
        questions: [
          {
            ...shortAnswer({ type: "LONG_ANSWER", text: `Design a churn model and attach your data. ${"Explain each step in detail. ".repeat(30)}`, marks: 10, guidance: "Features, model, validation." }),
            response: { type: "TEXT_FILE", allowedFileTypes: ["csv"], maxFileSizeMb: 1, maxFiles: 1, fileRequired: false },
          },
        ],
      },
    ],
  });
  const [bx, by] = [await createBatchWithLearners(course.id, 3), await createBatchWithLearners(course.id, 2)];
  await db.batch.update({ where: { id: bx.id }, data: { name: "Batch X" } });
  await db.batch.update({ where: { id: by.id }, data: { name: "Batch Y" } });
  const members = async (batchId: string) => (await db.batchMember.findMany({ where: { batchId }, orderBy: { user: { email: "asc" } }, select: { userId: true } })).map((m) => m.userId);
  const [xs, ys] = [await members(bx.id), await members(by.id)];
  const names = ["Asha Rao", "Bilal Khan", "Chen Li", "Divya Nair", "Esha Patel"];
  for (const [i, id] of [...xs, ...ys].entries()) await db.user.update({ where: { id }, data: { name: names[i] } });

  const startAt = hoursFromNow(1);
  const endAt = hoursFromNow(4);
  const assessment = await createAssessment(admin, assessmentInput(course.id, { name: "Churn Exam", type: "MIXED", paperId: paper.id, batchId: bx.id, startAt, endAt, durationMinutes: 60, passingMarks: 6, ...settings }));
  await publishAssessment(admin, assessment.id);
  await assignBatchToAssessment(admin, assessment.id, bx.id);
  await assignBatchToAssessment(admin, assessment.id, by.id);
  const issued = await issueExamCredentials(admin, assessment.id);
  const candidates = await listCandidates(admin, assessment.id);
  const cand = (learnerId: string) => candidates.find((c) => c.learner.id === learnerId)!;
  const [e1, e2] = [await createActor(Role.EXAMINER), await createActor(Role.EXAMINER)];
  await assignExaminer(admin, assessment.id, xs.map((id) => cand(id).id), e1.id);
  await assignExaminer(admin, assessment.id, ys.map((id) => cand(id).id), e2.id);

  const T0 = at(startAt, 10);
  async function begin(learnerId: string) {
    const email = cand(learnerId).learner.email;
    const r = await authenticateExamCredential(email, issued.find((i) => i.learner.email === email)!.code, {}, T0);
    if (!r.ok) throw new Error(r.reason);
    const me = (await validateSessionToken(r.token, T0))!;
    const view = await startOrResumeAttempt(me, T0);
    return { me, attemptId: view.attempt.id, q: questionsOf(view) };
  }

  const asha = await begin(xs[0]);
  const long = asha.q[2].assessmentQuestionId;
  await saveResponses(asha.me, asha.attemptId, { responses: [{ assessmentQuestionId: long, textAnswer: LONG }] }, at(T0, 2));
  const upload = await uploadAnswerFile(asha.me, asha.attemptId, long, { name: "churn-data.csv", data: Buffer.from("user,churned\n1,0\n") }, {}, at(T0, 3));
  await submitAttempt(
    asha.me,
    asha.attemptId,
    {
      responses: [
        { assessmentQuestionId: asha.q[0].assessmentQuestionId, selectedOptionIds: [asha.q[0].options[1].id] },
        { assessmentQuestionId: asha.q[1].assessmentQuestionId, selectedOptionIds: [asha.q[1].options[0].id] },
        { assessmentQuestionId: long, textAnswer: LONG },
      ],
    },
    at(T0, 30),
  );
  const bilal = await begin(xs[1]);
  await submitAttempt(bilal.me, bilal.attemptId, { responses: [{ assessmentQuestionId: bilal.q[0].assessmentQuestionId, selectedOptionIds: [bilal.q[0].options[0].id] }, { assessmentQuestionId: long, textAnswer: "Logistic regression." }] }, at(T0, 20));
  const chen = await begin(xs[2]);
  await terminateAttempt(admin, { assessmentId: assessment.id, attemptId: chen.attemptId, reason: "Suspected impersonation" }, at(T0, 5));
  const divya = await begin(ys[0]);
  await submitAttempt(divya.me, divya.attemptId, { responses: [{ assessmentQuestionId: divya.q[0].assessmentQuestionId, selectedOptionIds: [divya.q[0].options[1].id] }, { assessmentQuestionId: divya.q[1].assessmentQuestionId, selectedOptionIds: [divya.q[1].options[1].id] }] }, at(T0, 10));

  await saveEvaluation(e1, asha.attemptId, { marks: [{ assessmentQuestionId: long, awardedMarks: 8, comment: "Strong feature set; add a validation plan." }] });
  await finalizeEvaluation(e1, asha.attemptId);
  await saveEvaluation(e1, bilal.attemptId, { marks: [{ assessmentQuestionId: long, awardedMarks: 3 }] });
  if (finalize) await finalizeEvaluation(e1, bilal.attemptId);

  return { admin, assessment, endAt, T0, e1, e2, asha, bilal, chen, divya, long, fileId: upload.file.id };
}

describe("candidate result and detailed evaluation (PDF)", () => {
  it("1/3/8/11/12/13/17/18: admin downloads valid PDFs with the right marks, answers, feedback and file names", async () => {
    const s = await scenario();
    await signIn(s.admin);

    const res = await getAttemptReport(s.asha.attemptId, "result");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="candidate-result-asha-rao-attempt-1\.pdf"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    dump("candidate-result.pdf", bytes);
    // 17: a real PDF that a PDF reader can open.
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getTitle()).toBe("Candidate Result");
    const text = pdfText(bytes);
    for (const t of ["Accredian", "Candidate Result", "Asha Rao", "Churn Exam", "Batch X", "Submitted", "30 min 0 s", "Maximum marks", "13", "Marks obtained", "11", "84.62%", "Pass (passing marks 6)", "Evaluated", "Partially correct", "Correct", "Strong feature set; add a validation plan.", "Page 1 of"]) {
      expect(text, t).toContain(t);
    }
    // The individual result summarises questions only: no answers.
    expect(text).not.toContain("Churn features include tenure");

    const detailed = await getAttemptReport(s.asha.attemptId, "evaluation");
    expect(detailed.status).toBe(200);
    const dBytes = new Uint8Array(await detailed.arrayBuffer());
    dump("evaluation-report.pdf", dBytes);
    const doc = await PDFDocument.load(dBytes);
    const dText = pdfText(dBytes);
    for (const t of [
      "Detailed Evaluation Report",
      "Question 1",
      "Which metric is TP / (TP + FN)?",
      "[learner's answer, correct answer]",
      "Question 3",
      "Learner's answer",
      "Churn features include tenure",
      "churn-data.csv",
      "CSV",
      "17 B",
      "Examiner feedback: Strong feature set; add a validation plan.",
      "Model answer / marking guidance: Features, model, validation.",
    ]) {
      expect(dText, t).toContain(t);
    }
    // 18: the long answer runs over several pages; unsupported characters are replaced, not dropped.
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect(dText).toContain(`Page ${doc.getPageCount()} of ${doc.getPageCount()}`);
    expect(dText).toContain("“quoted”, naïve café, <= 5 and >= 2, ??.");
    // No storage internals — files are referenced by name only.
    const storageKey = (await db.storedFile.findUniqueOrThrow({ where: { id: s.fileId } })).storageKey;
    expect(Buffer.from(dBytes).toString("latin1")).not.toContain(storageKey);
    expect(dText).not.toContain(storageKey);
  });

  it("4/5: the assigned examiner can download; another examiner can't; neither gets assessment-wide results", async () => {
    const s = await scenario();
    await signIn(s.e1);
    expect((await getAttemptReport(s.asha.attemptId, "result")).status).toBe(200);
    expect((await getAttemptReport(s.asha.attemptId, "evaluation")).status).toBe(200);
    expect((await getResultsCsv(s.assessment.id)).status).toBe(403);

    await signIn(s.e2);
    for (const kind of ["result", "evaluation"]) {
      const r = await getAttemptReport(s.asha.attemptId, kind);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "Attempt not found." });
    }
    expect((await getAttemptReport(s.divya.attemptId, "result")).status).toBe(200);
  });

  it("6/7: learners can't download any report; unsigned requests and unknown report kinds are refused", async () => {
    const s = await scenario();
    for (const kind of ["result", "evaluation"] as const) {
      await expect(attemptReport(s.asha.me, s.asha.attemptId, kind)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(attemptReport(s.bilal.me, s.asha.attemptId, kind)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(assessmentResultsCsv(s.asha.me, s.assessment.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getAttemptReport(s.asha.attemptId, "result")).status).toBe(401);
    expect((await getResultsCsv(s.assessment.id)).status).toBe(401);
    await signIn(s.admin);
    expect((await getAttemptReport(s.asha.attemptId, "raw")).status).toBe(404);
    expect((await getAttemptReport("made-up", "result")).status).toBe(404);
  });

  it("14: pending evaluation is shown as pending, with no final marks or pass / fail", async () => {
    const s = await scenario({}, { finalize: false });
    const r = await attemptReport(s.admin, s.bilal.attemptId, "result");
    const text = pdfText(r.data);
    expect(text).toContain("Evaluation is still pending for this attempt");
    expect(text).toMatch(/Marks obtained[\s\S]*Pending Evaluation/);
    expect(text).not.toMatch(/\bPass \(|\bFail \(/);
  });

  it("15: no passing marks → no pass / fail anywhere", async () => {
    const s = await scenario({ passingMarks: 0 });
    const text = pdfText((await attemptReport(s.admin, s.asha.attemptId, "result")).data);
    expect(text).toContain("84.62%");
    expect(text).not.toMatch(/\bPass\b|\bFail\b/);
  });

  it("16: a terminated attempt stays terminated and unscored", async () => {
    const s = await scenario();
    const text = pdfText((await attemptReport(s.admin, s.chen.attemptId, "evaluation")).data);
    expect(text).toContain("Terminated");
    expect(text).toContain("Not scored (terminated)");
    expect(text).toContain("Not evaluated (terminated)");
    expect(text).not.toMatch(/\bPass \(|\bFail \(/);
    // Examiners only evaluate submitted attempts, so they get no report for it.
    await expect(attemptReport(s.e1, s.chen.attemptId, "result")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("downloads are audited (who, which attempt, which report)", async () => {
    const s = await scenario();
    await attemptReport(s.e1, s.asha.attemptId, "evaluation");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: AuditAction.REPORT_DOWNLOADED, actorId: s.e1.id } });
    expect(log).toMatchObject({ entityType: "AssessmentAttempt", entityId: s.asha.attemptId, metadata: { kind: "evaluation", assessmentId: s.assessment.id } });
  });
});

describe("assessment results (CSV)", () => {
  it("2/9/10/17: admin downloads one row per candidate attempt with statuses, timing and numeric marks", async () => {
    const s = await scenario({}, { finalize: false });
    await signIn(s.admin);
    const res = await getResultsCsv(s.assessment.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="assessment-results-churn-exam-\d{4}-\d{2}-\d{2}\.csv"/);
    const csvBytes = new Uint8Array(await res.arrayBuffer());
    dump("assessment-results.csv", csvBytes);
    const raw = Buffer.from(csvBytes).toString("utf8");
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain("\r\n");
    const [header, ...rows] = parseCsv(raw.slice(1));
    expect(header).toEqual([
      "Candidate name",
      "Candidate email (login ID)",
      "Candidate ID",
      "Batch",
      "Attempt number",
      "Attempt ID",
      "Attempt status",
      "Start time (IST)",
      "Submission time (IST)",
      "Terminated at (IST)",
      "Duration (minutes)",
      "Maximum marks",
      "Marks obtained",
      "Percentage",
      "Result (passing marks 6)",
      "Evaluation status",
    ]);
    const col = (name: string) => header.indexOf(name);
    const by = Object.fromEntries(rows.map((r) => [r[0], r]));
    // 9: every candidate, including one who never started; nobody from outside the assessment.
    expect(rows.map((r) => r[0])).toEqual(["Asha Rao", "Bilal Khan", "Chen Li", "Divya Nair", "Esha Patel"]);
    // 10: statuses and marks — pending, terminated and not-started are not given marks or pass / fail.
    const pick = (name: string) => ["Attempt status", "Duration (minutes)", "Maximum marks", "Marks obtained", "Percentage", "Result (passing marks 6)", "Evaluation status"].map((c) => by[name][col(c)]);
    expect(pick("Asha Rao")).toEqual(["Submitted", "30", "13", "11", "84.62", "Pass", "Evaluated"]);
    expect(pick("Bilal Khan")).toEqual(["Submitted", "20", "13", "", "", "Pending Evaluation", "Pending Evaluation"]);
    expect(pick("Chen Li")).toEqual(["Terminated", "5", "13", "", "", "Not applicable", "Not evaluated (terminated)"]);
    expect(pick("Divya Nair")).toEqual(["Submitted", "10", "13", "2", "15.38", "Fail", "Evaluated"]);
    expect(pick("Esha Patel")).toEqual(["Not started", "", "", "", "", "", "Not started"]);
    expect(by["Asha Rao"][col("Batch")]).toBe("Batch X");
    expect(by["Divya Nair"][col("Batch")]).toBe("Batch Y");
    expect(by["Asha Rao"][col("Start time (IST)")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(by["Chen Li"][col("Terminated at (IST)")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Numbers are written as numbers (no quotes), so Excel can sum and sort them.
    expect(raw).toMatch(/,13,11,84\.62,Pass,Evaluated\r\n/);
    // No answers or feedback in the summary.
    for (const t of ["Churn features", "Logistic regression", "Strong feature set", "churn-data.csv"]) expect(raw).not.toContain(t);
  });

  it("15: no passing marks → no result column", async () => {
    const s = await scenario({ passingMarks: 0 });
    const [header] = parseCsv(Buffer.from((await assessmentResultsCsv(s.admin, s.assessment.id)).data).toString("utf8").slice(1));
    expect(header.some((h) => /Result|Pass/.test(h))).toBe(false);
  });

  it("text can't become a spreadsheet formula; an assessment without candidates is a clear error", async () => {
    const s = await scenario();
    await db.user.update({ where: { id: s.asha.me.id }, data: { name: '=HYPERLINK("http://x","y")' } });
    const raw = Buffer.from((await assessmentResultsCsv(s.admin, s.assessment.id)).data).toString("utf8");
    expect(raw).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    const empty = await createAssessmentRow({ createdById: s.admin.id });
    await expect(assessmentResultsCsv(s.admin, empty.id)).rejects.toBeInstanceOf(ConflictError);
    await signIn(s.admin);
    const r = await getResultsCsv(empty.id);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/no candidates yet/);
  });
});

describe("unchanged behaviour", () => {
  it("19/20: reports show the same figures as the result and evaluation pages, which are unchanged", async () => {
    const s = await scenario();
    const admin = await getAttemptResult(s.admin, s.asha.attemptId);
    expect(admin.result).toMatchObject({ obtained: 11, maxMarks: 13, percentage: 84.62, complete: true });
    const ev = await getEvaluation(s.e1, s.asha.attemptId);
    expect(ev.questions.map((q) => q.awarded)).toEqual([2, 1, 8]);
    const list = await listAssessmentResults(s.admin, s.assessment.id);
    expect(list.candidates.find((c) => c.learner.name === "Asha Rao")?.best).toMatchObject({ obtained: 11, passed: true });
    for (const to of ["EVALUATION", "RESULT_READY", "PUBLISHED"] as const) await transitionAssessment(s.admin, s.assessment.id, to, at(s.endAt, 10));
    expect((await getMyResult(s.asha.me, s.asha.attemptId, at(s.endAt, 11))).result).toMatchObject({ obtained: 11, percentage: 84.62, passed: true });
  });
});
