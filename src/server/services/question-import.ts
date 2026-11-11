import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { ConflictError, ValidationError, type FieldErrors } from "@/lib/errors";
import { CsvError, parseCsv } from "@/lib/papers/csv";
import { interpretTemplateRows, type ParsedImport } from "@/lib/papers/import-template";
import { ruleNeedsCount } from "@/lib/papers/rules";
import { buildSnapshot } from "@/lib/questions/snapshot";
import { importPayloadSchema, type ImportPayload } from "@/lib/validation/paper";
import { AuditAction, recordAudit, recordAudits, type AuditEntry } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { newId } from "../ids";
import { insertPaper, loadEditablePaper, parsePaperDetails, type GroupSnapshot } from "./question-papers";
import { questionColumns } from "./questions";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * Parser boundary: one entry per file type. Only formats with a reliable, deterministic parser
 * are enabled. Others are listed so the user gets a clear message instead of a bad parse.
 */
const PARSERS: Record<string, { label: string; parse: (text: string) => ParsedImport } | { label: string; unsupported: string }> = {
  csv: { label: "CSV (question paper template)", parse: (text) => interpretTemplateRows(parseCsv(text)) },
  xlsx: {
    label: "Excel workbook",
    unsupported: "Excel workbooks can’t be read directly yet. In Excel, use File → Save As → “CSV UTF-8” on the template and upload the .csv file.",
  },
  xls: { label: "Excel 97–2003 workbook", unsupported: "Old Excel files aren’t supported. Save the template as “CSV UTF-8” and upload the .csv file." },
  docx: { label: "Word document", unsupported: "Word documents aren’t supported yet. Copy the questions into the template and upload it as CSV." },
  doc: { label: "Word 97–2003 document", unsupported: "Word documents aren’t supported yet. Copy the questions into the template and upload it as CSV." },
  pdf: { label: "PDF", unsupported: "PDF import isn’t supported yet (it needs AI-assisted extraction). Copy the questions into the template and upload it as CSV." },
};

export const SUPPORTED_IMPORT_FORMATS = Object.entries(PARSERS)
  .filter(([, p]) => "parse" in p)
  .map(([ext, p]) => ({ ext, label: p.label }));

/**
 * Upload → Parse. Returns the structured paper content plus every problem found, row by row,
 * for the review/edit step. Writes nothing to the database.
 */
export function parseQuestionImport(actor: SessionUser, file: { fileName: string; content: string }): ParsedImport & { fileName: string; format: string } {
  assertAdmin(actor);
  const ext = file.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const parser = PARSERS[ext];
  if (!parser) {
    throw new ValidationError(`“.${ext || "?"}” files can’t be imported. Supported: ${SUPPORTED_IMPORT_FORMATS.map((f) => `.${f.ext}`).join(", ")}.`, { file: ["Unsupported file type"] });
  }
  if ("unsupported" in parser) throw new ValidationError(parser.unsupported, { file: [`${parser.label} files aren’t supported yet`] });
  if (Buffer.byteLength(file.content, "utf8") > MAX_IMPORT_BYTES) throw new ValidationError("The file is larger than 2 MB.", { file: ["File too large"] });

  try {
    return { ...parser.parse(file.content), fileName: file.fileName, format: ext };
  } catch (err) {
    if (err instanceof CsvError) throw new ValidationError(`The file couldn’t be read: ${err.message}`, { file: [err.message] });
    throw err;
  }
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Cross-item checks the per-question schema can't do: duplicates and attempt-rule counts. */
function payloadIssues(payload: ImportPayload, existingTexts: Set<string>): FieldErrors {
  const errors: FieldErrors = {};
  const seen = new Map<string, string>();
  payload.sections.forEach((s, si) => {
    if (ruleNeedsCount(s.attemptRule) && s.attemptCount != null && s.attemptCount > s.items.length) {
      (errors[`sections.${si}.attemptCount`] ??= []).push(`The section asks for ${s.attemptCount} questions but has ${s.items.length}.`);
    }
    s.items.forEach((item, ii) => {
      const questions = item.kind === "question" ? [{ q: item.question, path: `sections.${si}.items.${ii}.question.text` }] : item.children.map((q, ci) => ({ q, path: `sections.${si}.items.${ii}.children.${ci}.text` }));
      for (const { q, path } of questions) {
        const k = `${q.type}|${norm(q.text)}`;
        if (existingTexts.has(k)) (errors[path] ??= []).push("This question is already in the paper.");
        else if (seen.has(k)) (errors[path] ??= []).push(`Duplicate of ${seen.get(k)}.`);
        else seen.set(k, path);
      }
    });
  });
  return errors;
}

function parsePayload(raw: unknown): ImportPayload {
  const parsed = importPayloadSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, "Some imported questions need fixing before they can be saved.");
  return parsed.data;
}

type ImportItem = ImportPayload["sections"][number]["items"][number];
type ImportQuestion = Extract<ImportItem, { kind: "question" }>["question"];

/** Rows per createMany statement (well under PostgreSQL's bind-parameter limit for every table here). */
const INSERT_CHUNK = 500;

async function createInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) await insert(rows.slice(i, i + INSERT_CHUNK));
}

type Rows = {
  sections: Prisma.PaperSectionCreateManyInput[];
  questions: Prisma.QuestionCreateManyInput[];
  options: Prisma.QuestionOptionCreateManyInput[];
  groups: Prisma.PaperQuestionCreateManyInput[];
  items: Prisma.PaperQuestionCreateManyInput[];
  audits: AuditEntry[];
};

/**
 * Every row of an import, built in memory (ids generated here, positions computed here), so the
 * writes are a fixed handful of bulk inserts however many questions there are — instead of about ten
 * sequential queries per question (course check, question, each option, read-back, audit, position,
 * paper item), which made a 50-question import exceed the 60 s transaction limit over the network.
 * Same rows and values as adding each question one by one: bank question (version 1) with its options,
 * frozen snapshot, marks and negative marks, the item's position in its section (or group), groups first.
 */
function buildImportRows(
  actorId: string,
  paper: { id: string; courseId: string },
  payload: ImportPayload,
  existingSections: { id: string; title: string; position: number }[],
  lastPosition: Map<string, number>,
): Rows & { summary: { sectionsCreated: number; questionsAdded: number; groupsAdded: number } } {
  const rows: Rows = { sections: [], questions: [], options: [], groups: [], items: [], audits: [] };
  let nextSection = Math.max(0, ...existingSections.map((x) => x.position)) + 1;
  let questionsAdded = 0;
  let groupsAdded = 0;

  const question = (sectionId: string, parentId: string | null, position: number, data: ImportQuestion) => {
    const id = newId();
    const options = data.options.map((o, i) => ({ id: newId(), text: o.text, isCorrect: o.isCorrect, position: i }));
    rows.questions.push({ id, ...questionColumns({ ...data, courseId: paper.courseId }), createdById: actorId });
    for (const o of options) rows.options.push({ ...o, questionId: id });
    const snapshot = buildSnapshot({ id, version: 1, type: data.type, text: data.text, guidance: data.guidance, topic: data.topic, difficulty: data.difficulty, options });
    rows.items.push({
      id: newId(),
      paperId: paper.id,
      sectionId,
      parentId,
      position,
      questionId: id,
      marks: data.marks,
      negativeMarks: data.negativeMarks,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      questionVersion: 1,
    });
    rows.audits.push({ actorId, action: AuditAction.QUESTION_CREATED, entityType: "Question", entityId: id, metadata: { type: data.type } });
    questionsAdded++;
  };

  for (const s of payload.sections) {
    const { items, ...config } = s;
    let sectionId = existingSections.find((x) => norm(x.title) === norm(config.title))?.id;
    if (!sectionId) {
      sectionId = newId();
      rows.sections.push({ id: sectionId, paperId: paper.id, ...config, attemptCount: config.attemptCount ?? null, position: nextSection++ });
    }
    let position = lastPosition.get(sectionId) ?? 0;
    for (const item of items) {
      if (item.kind === "question") {
        question(sectionId, null, ++position, item.question);
      } else {
        const groupId = newId();
        const snapshot: GroupSnapshot = { kind: "group", groupType: item.group.groupType, text: item.group.text, passage: item.group.passage };
        rows.groups.push({ id: groupId, paperId: paper.id, sectionId, parentId: null, position: ++position, groupType: item.group.groupType, snapshot: snapshot as unknown as Prisma.InputJsonValue });
        groupsAdded++;
        item.children.forEach((child, ci) => question(sectionId, groupId, ci + 1, child));
      }
    }
    lastPosition.set(sectionId, position);
  }
  return { ...rows, summary: { sectionsCreated: rows.sections.length, questionsAdded, groupsAdded } };
}

/**
 * Write a validated payload into a draft paper inside the caller's transaction. Sections whose
 * title matches an existing section (case-insensitive) receive the questions; others are created
 * at the end. Duplicates (within the payload or against the paper) and impossible attempt rules
 * are rejected before anything is written. Reads: 3 queries; writes: one bulk insert per table.
 */
async function writeImport(tx: DbTx, actor: SessionUser, paper: { id: string; courseId: string }, payload: ImportPayload, options: { newPaper?: boolean } = {}) {
  const paperId = paper.id;
  if (!options.newPaper) {
    // A new paper has no questions yet (its duplicates were checked before the transaction).
    const existing = await tx.paperQuestion.findMany({ where: { paperId, questionId: { not: null } }, select: { snapshot: true } });
    const existingTexts = new Set(existing.map((e) => e.snapshot as { type: string; text: string }).map((s) => `${s.type}|${norm(s.text)}`));
    const issues = payloadIssues(payload, existingTexts);
    if (Object.keys(issues).length) throw new ValidationError("Some imported questions need fixing before they can be saved.", issues);
  }

  const sections = options.newPaper ? [] : await tx.paperSection.findMany({ where: { paperId }, select: { id: true, title: true, position: true } });
  const last = options.newPaper
    ? []
    : await tx.paperQuestion.groupBy({ by: ["sectionId"], where: { paperId, parentId: null }, _max: { position: true } });
  const lastPosition = new Map(last.map((l) => [l.sectionId, l._max.position ?? 0]));
  const rows = buildImportRows(actor.id, paper, payload, sections, lastPosition);

  await createInChunks(rows.sections, (data) => tx.paperSection.createMany({ data }));
  await createInChunks(rows.questions, (data) => tx.question.createMany({ data }));
  await createInChunks(rows.options, (data) => tx.questionOption.createMany({ data }));
  // Groups before their sub-questions (which reference them).
  await createInChunks(rows.groups, (data) => tx.paperQuestion.createMany({ data }));
  await createInChunks(rows.items, (data) => tx.paperQuestion.createMany({ data }));
  await createInChunks(rows.audits, (entries) => recordAudits(entries, tx));

  await tx.questionPaper.update({ where: { id: paperId }, data: { updatedById: actor.id, ...(payload.sourceFileName ? { sourceFileName: payload.sourceFileName } : {}) } });
  await recordAudit(
    { actorId: actor.id, action: AuditAction.PAPER_IMPORTED, entityType: "QuestionPaper", entityId: paperId, metadata: { ...rows.summary, sourceFileName: payload.sourceFileName } },
    tx,
  );
  return rows.summary;
}

/**
 * Database failures during an import become a clear message for the person importing — the import
 * is all-or-nothing, so nothing was saved. Details stay in the server log (never shown).
 */
function importFailure(err: unknown): never {
  if (err instanceof ValidationError || err instanceof ConflictError) throw err;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    console.error("[question import] database error", err.code, err.message);
    if (err.code === "P2028") throw new ConflictError("The import took too long and was cancelled — nothing was saved. Please try again; if it keeps happening, split the file into smaller parts.");
    if (err.code === "P2002") throw new ConflictError("Some of these questions conflict with ones already saved — nothing was saved. Reload the paper and try again.");
    if (err.code === "P2003") throw new ConflictError("The paper or its course changed while importing — nothing was saved. Reload and try again.");
    throw new ConflictError("The questions couldn’t be saved — nothing was saved. Please try again.");
  }
  throw err;
}

/**
 * Review/Edit → Save. Validates the whole (possibly corrected) payload and writes it into a draft
 * paper in one transaction: all of it or nothing.
 */
export async function saveImportToPaper(actor: SessionUser, paperId: string, raw: unknown) {
  assertAdmin(actor);
  const payload = parsePayload(raw);
  return db
    .$transaction(
      async (tx) => {
        const paper = await loadEditablePaper(tx, paperId);
        return writeImport(tx, actor, paper, payload);
      },
      // One transaction so a failure leaves nothing behind; bulk inserts keep it short.
      { timeout: 60_000 },
    )
    .catch(importFailure);
}

/**
 * Create a draft paper and import its questions in one transaction: if the import is rejected,
 * the paper isn't created either.
 */
export async function createPaperFromImport(actor: SessionUser, rawDetails: unknown, rawPayload: unknown) {
  assertAdmin(actor);
  const details = parsePaperDetails(rawDetails);
  const payload = parsePayload(rawPayload);
  // Everything that can be checked without the database is checked before the transaction starts.
  const issues = payloadIssues(payload, new Set());
  if (Object.keys(issues).length) throw new ValidationError("Some imported questions need fixing before they can be saved.", issues);
  return db
    .$transaction(
      async (tx) => {
        const paper = await insertPaper(tx, actor.id, details, { sourceFileName: payload.sourceFileName });
        const summary = await writeImport(tx, actor, paper, payload, { newPaper: true });
        return { paper, summary };
      },
      { timeout: 60_000 },
    )
    .catch(importFailure);
}
