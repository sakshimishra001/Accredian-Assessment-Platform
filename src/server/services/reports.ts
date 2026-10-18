import "server-only";
import { AssessmentStatus, AttemptStatus, Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { formatBytes } from "@/lib/files/types";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { formatDate, formatDateTime } from "@/prototype/lib/format";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin, assertRole } from "../authz";
import { db } from "../db";
import { ReportDocument, type Column } from "../reports/pdf";
import { closeExpiredAttempts } from "./attempts";
import { assertAssigned } from "./evaluations";
import { attemptBreakdown, loadResultAttempt, resultAttemptSelect, resultOf, timeTakenSeconds, type AnswerStatus, type ResultAttemptRow } from "./results";

/*
 * Result downloads: an individual candidate result (PDF), a detailed evaluation report (PDF) and the
 * assessment's results (CSV). Every value comes from the existing result calculation — the same
 * figures as the result and evaluation pages; nothing is re-scored here.
 *
 * Access: admins — any attempt and any assessment. Examiners — only submitted attempts of
 * candidates assigned to them (the evaluation assignment check), and no assessment-wide report.
 * Anyone else is refused. Downloads are audited.
 */

export type ReportKind = "result" | "evaluation";

const SUBMITTED: AttemptStatus[] = [AttemptStatus.SUBMITTED, AttemptStatus.AUTO_SUBMITTED];

const ANSWER_STATUS: Record<AnswerStatus, string> = {
  CORRECT: "Correct",
  INCORRECT: "Incorrect",
  PARTIALLY_CORRECT: "Partially correct",
  UNANSWERED: "Unanswered",
  EVALUATED: "Evaluated",
  PENDING_EVALUATION: "Pending Evaluation",
};

type AttemptState = Pick<ResultAttemptRow, "status" | "lockedAt"> & { assessmentStatus: AssessmentStatus };

/** The attempt's persisted state, keeping active, paused, locked, submitted and terminated apart. */
export function attemptStatusLabel(a: AttemptState) {
  switch (a.status) {
    case AttemptStatus.IN_PROGRESS:
      return a.lockedAt ? "Locked" : a.assessmentStatus === AssessmentStatus.PAUSED ? "Paused" : "Active (in progress)";
    case AttemptStatus.SUBMITTED:
      return "Submitted";
    case AttemptStatus.AUTO_SUBMITTED:
      return "Auto-submitted (time limit)";
    case AttemptStatus.TERMINATED:
      return "Terminated";
  }
}

/** Evaluated only when the result is final; a terminated attempt is never evaluated. */
export function evaluationStatusLabel(status: AttemptStatus, final: boolean) {
  if (status === AttemptStatus.TERMINATED) return "Not evaluated (terminated)";
  if (status === AttemptStatus.IN_PROGRESS) return "Not submitted";
  return final ? "Evaluated" : "Pending Evaluation";
}

const ist = (d: Date | null | undefined) => (d ? `${formatDateTime(d.toISOString())} IST` : "-");
const minutes = (seconds: number | null) => (seconds === null ? null : Math.round((seconds / 60) * 100) / 100);
const durationText = (seconds: number | null) => (seconds === null ? "-" : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);
const slug = (s: string) => s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60) || "report";

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

/** The attempt, if this user may report on it: admins any; examiners their assigned, submitted ones. */
async function loadReportAttempt(actor: SessionUser, attemptId: string) {
  assertRole(actor, Role.ADMIN, Role.EXAMINER);
  if (actor.role === Role.EXAMINER) await assertAssigned(db, actor, attemptId);
  const row = await loadResultAttempt(db, attemptId);
  if (!row) throw new NotFoundError("Attempt not found.");
  return row;
}

/** Everything both PDFs show, from the evaluation breakdown (the admin / examiner view of an attempt). */
async function attemptReportData(row: ResultAttemptRow) {
  const b = attemptBreakdown(row);
  const course = await db.assessment.findUniqueOrThrow({ where: { id: row.assessmentId }, select: { courseId: true, startAt: true } });
  const batches = await db.batchMember.findMany({ where: { userId: row.learnerId, batch: { courseId: course.courseId } }, select: { batch: { select: { name: true } } }, orderBy: { batch: { name: "asc" } } });
  const passingMarks = row.assessment.passingMarks.toNumber();
  const terminated = row.status === AttemptStatus.TERMINATED;
  const final = !terminated && b.result.final;
  return {
    b,
    terminated,
    final,
    batch: batches.map((m) => m.batch.name).join(", ") || b.assessment.batch?.name || "-",
    assessmentDate: course.startAt,
    passingMarks: passingMarks > 0 ? passingMarks : null,
    attemptStatus: attemptStatusLabel({ status: row.status, lockedAt: row.lockedAt, assessmentStatus: row.assessment.status }),
    evaluationStatus: evaluationStatusLabel(row.status, final),
  };
}

type ReportData = Awaited<ReturnType<typeof attemptReportData>>;

function candidateFacts(d: ReportData): [string, string][] {
  return [
    ["Learner name", d.b.learner.name],
    ["Email (login ID)", d.b.learner.email],
    ["Attempt", `#${d.b.attempt.attemptNumber}`],
    ["Attempt ID", d.b.attempt.id],
  ];
}

function assessmentFacts(d: ReportData): [string, string][] {
  const a = d.b.attempt;
  return [
    ["Assessment", d.b.assessment.name],
    ["Batch", d.batch],
    ["Assessment date", formatDate(d.assessmentDate.toISOString())],
    ["Attempt status", d.attemptStatus],
    ["Start time", ist(a.startedAt)],
    [d.terminated ? "Terminated at" : "Submission time", ist(d.terminated ? a.terminatedAt : a.submittedAt)],
    ["Duration", durationText(a.timeTakenSeconds)],
    ["Evaluation status", d.evaluationStatus],
  ];
}

function overallFacts(d: ReportData): [string, string][] {
  const r = d.b.result;
  const obtained = d.terminated ? "Not scored (terminated)" : d.final ? String(r.obtained) : "Pending Evaluation";
  const facts: [string, string][] = [
    ["Maximum marks", String(r.maxMarks)],
    ["Marks obtained", obtained],
    ["Percentage", d.final ? `${r.percentage}%` : d.terminated ? "-" : "Pending Evaluation"],
  ];
  // Pass / fail only when the assessment sets passing marks, and only on a final result.
  if (d.passingMarks !== null) facts.push(["Result", d.final ? (r.passed ? `Pass (passing marks ${d.passingMarks})` : `Fail (passing marks ${d.passingMarks})`) : d.terminated ? "Not applicable" : "Pending Evaluation"]);
  facts.push(["Questions", `${r.counts.questions} (${r.counts.answered} answered, ${r.counts.unanswered} unanswered)`]);
  return facts;
}

/** Per-question marks and status; nothing is shown as scored for a terminated attempt. */
function questionMarks(d: ReportData, q: ReportData["b"]["questions"][number]) {
  if (d.terminated) return { marks: "-", status: "Not scored (terminated)" };
  return { marks: q.awarded === null ? "-" : String(q.awarded), status: ANSWER_STATUS[q.status] };
}

async function candidateResultPdf(d: ReportData, generatedAt: string) {
  const doc = await ReportDocument.create("Candidate Result", generatedAt);
  doc.title("Candidate Result", `${d.b.assessment.name} · ${d.b.learner.name}`);
  if (d.terminated) doc.paragraph(`This attempt was terminated${d.b.attempt.terminationReason ? ` (${d.b.attempt.terminationReason})` : ""}. It is not a submission and is not scored.`, { shade: true });
  else if (!d.final) doc.paragraph("Evaluation is still pending for this attempt: marks shown are not final and no pass / fail result is given yet.", { shade: true });
  doc.heading("Candidate information");
  doc.facts(candidateFacts(d));
  doc.heading("Assessment information");
  doc.facts(assessmentFacts(d));
  doc.heading("Overall result");
  doc.facts(overallFacts(d));
  doc.heading("Question-wise summary");
  const columns: Column[] = [
    { header: "Q", width: 6 },
    { header: "Section", width: 18 },
    { header: "Type", width: 14 },
    { header: "Max", width: 7, align: "right" },
    { header: "Obtained", width: 9, align: "right" },
    { header: "Status", width: 15 },
    { header: "Examiner feedback", width: 31 },
  ];
  doc.table(
    columns,
    d.b.questions.map((q) => {
      const m = questionMarks(d, q);
      return [q.number, q.section ?? "-", QUESTION_TYPES[q.type].label, String(q.maxMarks), m.marks, m.status, q.examinerComment ?? "-"];
    }),
  );
  return doc.save();
}

async function evaluationPdf(d: ReportData, generatedAt: string) {
  const doc = await ReportDocument.create("Detailed Evaluation Report", generatedAt);
  doc.title("Detailed Evaluation Report", `${d.b.assessment.name} · ${d.b.learner.name}`);
  if (d.terminated) doc.paragraph(`This attempt was terminated${d.b.attempt.terminationReason ? ` (${d.b.attempt.terminationReason})` : ""}. It is not a submission and is not scored; the saved answers are shown.`, { shade: true });
  else if (!d.final) doc.paragraph("Evaluation is still pending for this attempt: some answers have no marks yet and no pass / fail result is given.", { shade: true });
  doc.heading("Candidate information");
  doc.facts(candidateFacts(d));
  doc.heading("Assessment information");
  doc.facts(assessmentFacts(d));
  doc.heading("Overall result");
  doc.facts(overallFacts(d));
  doc.heading("Question-by-question evaluation");
  d.b.questions.forEach((q, i) => {
    if (i > 0) doc.rule();
    const m = questionMarks(d, q);
    doc.paragraph(`Question ${q.number}${q.section ? ` · ${q.section}` : ""} · ${QUESTION_TYPES[q.type].label}`, { bold: true, size: 10.5 });
    doc.paragraph(`Marks: ${m.marks} / ${q.maxMarks}   ·   Status: ${m.status}`, { size: 9, color: "muted" });
    if (q.context) doc.paragraph(`Case: ${q.context.text}${q.context.passage ? `\n${q.context.passage}` : ""}`, { size: 9, italic: true, color: "muted" });
    doc.paragraph(q.text);
    if (q.kind === "objective") {
      const letter = (id: string) => String.fromCharCode(65 + q.options.findIndex((o) => o.id === id));
      q.options.forEach((o, n) => {
        const tags = [q.answer.selectedOptionIds.includes(o.id) ? "learner's answer" : null, o.isCorrect ? "correct answer" : null].filter(Boolean).join(", ");
        doc.paragraph(`${String.fromCharCode(65 + n)}. ${o.text}${tags ? `   [${tags}]` : ""}`, { indent: 12, bold: !!tags });
      });
      doc.paragraph(`Learner's answer: ${q.answer.selectedOptionIds.map(letter).join(", ") || "Unanswered"}   ·   Correct answer: ${q.options.filter((o) => o.isCorrect).map((o) => letter(o.id)).join(", ")}`, { size: 9 });
    } else {
      doc.paragraph("Learner's answer", { bold: true, size: 9, color: "muted" });
      doc.paragraph(q.answer.textAnswer?.trim() ? q.answer.textAnswer : q.answer.files.length ? "(No written text - see the submitted file.)" : "Unanswered", { shade: true });
      if (q.answer.files.length) {
        doc.paragraph("Submitted files (available in the platform through protected file access)", { bold: true, size: 9, color: "muted" });
        for (const f of q.answer.files) doc.paragraph(`${f.fileName}  ·  ${f.extension.toUpperCase()}  ·  ${formatBytes(f.sizeBytes)}`, { indent: 12, size: 9 });
      }
      if (q.guidance) doc.paragraph(`Model answer / marking guidance: ${q.guidance}`, { size: 9, color: "muted" });
    }
    if (q.examinerComment) doc.paragraph(`Examiner feedback: ${q.examinerComment}`, { size: 9.5 });
    if (q.evaluatedBy) doc.paragraph(`Marked by ${q.evaluatedBy.name}${q.evaluatedAt ? ` on ${ist(q.evaluatedAt)}` : ""}`, { size: 8, color: "muted" });
  });
  return doc.save();
}

/** An individual result or detailed evaluation PDF for one attempt. */
export async function attemptReport(actor: SessionUser, attemptId: string, kind: ReportKind, now: Date = new Date()) {
  const row = await loadReportAttempt(actor, attemptId);
  const d = await attemptReportData(row);
  const generatedAt = `${formatDateTime(now.toISOString())} IST`;
  const data = kind === "result" ? await candidateResultPdf(d, generatedAt) : await evaluationPdf(d, generatedAt);
  await recordAudit({ actorId: actor.id, action: AuditAction.REPORT_DOWNLOADED, entityType: "AssessmentAttempt", entityId: attemptId, metadata: { kind, assessmentId: row.assessmentId } });
  return {
    fileName: `${kind === "result" ? "candidate-result" : "evaluation-report"}-${slug(row.learner.name)}-attempt-${row.attemptNumber}.pdf`,
    contentType: "application/pdf",
    data,
  };
}

// ---------------------------------------------------------------------------
// Assessment results (CSV)
// ---------------------------------------------------------------------------

/** "2026-10-12 14:05:00" in IST — a form Excel reads as a date and time. */
const istStamp = (d: Date | null) => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace("T", " ") : null);

/** One CSV field: numbers stay numbers; text is quoted when needed and can't start a formula. */
function csvField(v: string | number | null) {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Every candidate's attempts with status, timing, marks and evaluation status — no answers. */
export async function assessmentResultsCsv(actor: SessionUser, assessmentId: string, now: Date = new Date()) {
  assertAdmin(actor);
  await closeExpiredAttempts(now, assessmentId);
  const { assessment: assessmentSelect, ...attemptSelect } = resultAttemptSelect;
  // Three queries whatever the number of candidates, attempts or answers.
  const assessment = await db.assessment.findUnique({ where: { id: assessmentId }, select: { ...assessmentSelect.select, courseId: true } });
  if (!assessment) throw new NotFoundError("Assessment not found.");
  const [candidates, attempts] = await Promise.all([
    db.assessmentCandidate.findMany({
      where: { assessmentId },
      orderBy: [{ learner: { name: "asc" } }, { learner: { email: "asc" } }],
      select: { id: true, learner: { select: { name: true, email: true, batchMemberships: { where: { batch: { courseId: assessment.courseId } }, select: { batch: { select: { name: true } } } } } } },
    }),
    db.assessmentAttempt.findMany({ where: { assessmentId }, orderBy: { attemptNumber: "asc" }, select: { ...attemptSelect, candidateId: true } }),
  ]);
  if (candidates.length === 0) throw new ConflictError("This assessment has no candidates yet, so there are no results to download.");

  const passingMarks = assessment.passingMarks.toNumber();
  const hasPassRule = passingMarks > 0;
  const header = [
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
    ...(hasPassRule ? [`Result (passing marks ${passingMarks})`] : []),
    "Evaluation status",
  ];
  const lines = [header.map(csvField).join(",")];
  const byCandidate = new Map<string, typeof attempts>();
  for (const a of attempts) byCandidate.set(a.candidateId, [...(byCandidate.get(a.candidateId) ?? []), a]);

  for (const c of candidates) {
    const who = [c.learner.name, c.learner.email, c.id, c.learner.batchMemberships.map((m) => m.batch.name).sort().join("; ") || assessment.batch?.name || null];
    const mine = byCandidate.get(c.id) ?? [];
    if (mine.length === 0) {
      lines.push([...who, null, null, "Not started", null, null, null, null, null, null, null, ...(hasPassRule ? [null] : []), "Not started"].map(csvField).join(","));
      continue;
    }
    for (const a of mine) {
      const row = { ...a, assessment } as unknown as ResultAttemptRow;
      const terminated = a.status === AttemptStatus.TERMINATED;
      const r = resultOf(row);
      const final = !terminated && r.final;
      const submitted = SUBMITTED.includes(a.status);
      const result = !hasPassRule ? [] : [final ? (r.passed ? "Pass" : "Fail") : terminated ? "Not applicable" : submitted ? "Pending Evaluation" : null];
      lines.push(
        [
          ...who,
          a.attemptNumber,
          a.id,
          attemptStatusLabel({ status: a.status, lockedAt: a.lockedAt, assessmentStatus: assessment.status }),
          istStamp(a.startedAt),
          istStamp(a.submittedAt),
          istStamp(a.terminatedAt),
          a.status === AttemptStatus.IN_PROGRESS ? null : minutes(timeTakenSeconds(a)),
          r.maxMarks,
          final ? r.obtained : null,
          final ? r.percentage : null,
          ...result,
          evaluationStatusLabel(a.status, final),
        ]
          .map(csvField)
          .join(","),
      );
    }
  }
  await recordAudit({ actorId: actor.id, action: AuditAction.REPORT_DOWNLOADED, entityType: "Assessment", entityId: assessmentId, metadata: { kind: "assessment-results", rows: lines.length - 1 } });
  // UTF-8 with a BOM and CRLF line ends, so Excel opens names and dates correctly.
  return {
    fileName: `assessment-results-${slug(assessment.name)}-${istStamp(now)!.slice(0, 10)}.csv`,
    contentType: "text/csv; charset=utf-8",
    data: new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`),
  };
}
