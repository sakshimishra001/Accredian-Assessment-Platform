import "server-only";
import { ValidationError, type FieldErrors } from "@/lib/errors";
import { CsvError, parseCsv } from "@/lib/papers/csv";
import { interpretTemplateRows, type ParsedImport } from "@/lib/papers/import-template";
import { ruleNeedsCount } from "@/lib/papers/rules";
import { importPayloadSchema, type ImportPayload } from "@/lib/validation/paper";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { insertPaper, insertPaperGroup, insertPaperQuestion, insertSection, loadEditablePaper, parsePaperDetails } from "./question-papers";

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

/**
 * Write a validated payload into a draft paper inside the caller's transaction. Sections whose
 * title matches an existing section (case-insensitive) receive the questions; others are created
 * at the end. Duplicates (within the payload or against the paper) and impossible attempt rules
 * are rejected before anything is written.
 */
async function writeImport(tx: DbTx, actor: SessionUser, paper: { id: string; courseId: string }, payload: ImportPayload) {
  const paperId = paper.id;
  const existing = await tx.paperQuestion.findMany({ where: { paperId, questionId: { not: null } }, select: { snapshot: true } });
  const existingTexts = new Set(existing.map((e) => e.snapshot as { type: string; text: string }).map((s) => `${s.type}|${norm(s.text)}`));
  const issues = payloadIssues(payload, existingTexts);
  if (Object.keys(issues).length) throw new ValidationError("Some imported questions need fixing before they can be saved.", issues);

  const sections = await tx.paperSection.findMany({ where: { paperId }, select: { id: true, title: true } });
  let sectionsCreated = 0;
  let questionsAdded = 0;
  let groupsAdded = 0;
  for (const s of payload.sections) {
    const { items, ...config } = s;
    let sectionId = sections.find((x) => norm(x.title) === norm(config.title))?.id;
    if (!sectionId) {
      sectionId = (await insertSection(tx, paperId, config)).id;
      sectionsCreated++;
    }
    for (const item of items) {
      if (item.kind === "question") {
        await insertPaperQuestion(tx, actor.id, paper, sectionId, null, item.question);
        questionsAdded++;
      } else {
        const group = await insertPaperGroup(tx, paperId, sectionId, item.group);
        groupsAdded++;
        for (const child of item.children) {
          await insertPaperQuestion(tx, actor.id, paper, sectionId, group.id, child);
          questionsAdded++;
        }
      }
    }
  }
  await tx.questionPaper.update({ where: { id: paperId }, data: { updatedById: actor.id, ...(payload.sourceFileName ? { sourceFileName: payload.sourceFileName } : {}) } });
  const summary = { sectionsCreated, questionsAdded, groupsAdded };
  await recordAudit(
    { actorId: actor.id, action: AuditAction.PAPER_IMPORTED, entityType: "QuestionPaper", entityId: paperId, metadata: { ...summary, sourceFileName: payload.sourceFileName } },
    tx,
  );
  return summary;
}

/**
 * Review/Edit → Save. Validates the whole (possibly corrected) payload and writes it into a draft
 * paper in one transaction: all of it or nothing.
 */
export async function saveImportToPaper(actor: SessionUser, paperId: string, raw: unknown) {
  assertAdmin(actor);
  const payload = parsePayload(raw);
  return db.$transaction(
    async (tx) => {
      const paper = await loadEditablePaper(tx, paperId);
      return writeImport(tx, actor, paper, payload);
    },
    // Large imports create many rows; keep them in one transaction so a failure leaves nothing behind.
    { timeout: 60_000 },
  );
}

/**
 * Create a draft paper and import its questions in one transaction: if the import is rejected,
 * the paper isn't created either.
 */
export async function createPaperFromImport(actor: SessionUser, rawDetails: unknown, rawPayload: unknown) {
  assertAdmin(actor);
  const details = parsePaperDetails(rawDetails);
  const payload = parsePayload(rawPayload);
  return db.$transaction(
    async (tx) => {
      const paper = await insertPaper(tx, actor.id, details, { sourceFileName: payload.sourceFileName });
      const summary = await writeImport(tx, actor, paper, payload);
      return { paper, summary };
    },
    { timeout: 60_000 },
  );
}
