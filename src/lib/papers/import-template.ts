import { QuestionGroupType, QuestionType, SectionAttemptRule } from "@/generated/prisma/enums";
import { hasOptions } from "@/lib/questions/types";
import { questionInputSchema } from "@/lib/validation/question";
import { sectionSchema, type ImportPayloadInput } from "@/lib/validation/paper";

/**
 * The question-paper import template ("Excel template" in the UI): one row per question, saved
 * as CSV. Column names are case-insensitive; only `section`, `type`, `question` and `marks` are
 * required. Rows sharing a `group` key form one case study / comprehension with sub-questions.
 */
export const TEMPLATE_COLUMNS = [
  "section",
  "section_instructions",
  "section_rule",
  "section_count",
  "section_required",
  "group",
  "group_type",
  "group_text",
  "passage",
  "type",
  "question",
  "option_a",
  "option_b",
  "option_c",
  "option_d",
  "option_e",
  "option_f",
  "correct",
  "marks",
  "negative_marks",
  "topic",
  "difficulty",
  "guidance",
] as const;

const REQUIRED_COLUMNS = ["section", "type", "question", "marks"] as const;
const OPTION_COLUMNS = ["option_a", "option_b", "option_c", "option_d", "option_e", "option_f"] as const;
export const MAX_IMPORT_ROWS = 1000;

type Column = (typeof TEMPLATE_COLUMNS)[number];
type Row = Partial<Record<Column, string>>;

export interface ImportIssue {
  /** 1-based spreadsheet row (the header is row 1). 0 = whole file. */
  row: number;
  field?: string;
  message: string;
}

export interface ParsedImport {
  /** Structured paper content, ready for review/editing and then saving (see importPayloadSchema). */
  payload: ImportPayloadInput;
  /** Every problem found. The payload can only be saved once these are fixed. */
  issues: ImportIssue[];
  /** For each item in the payload: the spreadsheet row it came from (sections[i].items[j] → rows). */
  sourceRows: number[][];
  summary: { rows: number; sections: number; questions: number; groups: number; invalidRows: number };
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  MCQ: QuestionType.MCQ_SINGLE,
  MCQ_SINGLE: QuestionType.MCQ_SINGLE,
  SINGLE: QuestionType.MCQ_SINGLE,
  MCQ_MULTI: QuestionType.MCQ_MULTI,
  MCQ_MULTIPLE: QuestionType.MCQ_MULTI,
  MULTI: QuestionType.MCQ_MULTI,
  MULTIPLE: QuestionType.MCQ_MULTI,
  TRUE_FALSE: QuestionType.TRUE_FALSE,
  TF: QuestionType.TRUE_FALSE,
  SHORT_ANSWER: QuestionType.SHORT_ANSWER,
  SHORT: QuestionType.SHORT_ANSWER,
  LONG_ANSWER: QuestionType.LONG_ANSWER,
  LONG: QuestionType.LONG_ANSWER,
};

const key = (v: string) => v.trim().toUpperCase().replace(/[\s/-]+/g, "_");

function parseRule(raw: string | undefined): { rule: SectionAttemptRule; isRequired?: boolean } | null {
  if (!raw?.trim()) return { rule: SectionAttemptRule.ALL };
  const k = key(raw);
  if (k === "ALL" || k === "COMPULSORY" || k === "ATTEMPT_ALL") return { rule: SectionAttemptRule.ALL };
  if (k === "OPTIONAL") return { rule: SectionAttemptRule.ALL, isRequired: false };
  if (k in SectionAttemptRule) return { rule: k as SectionAttemptRule };
  return null;
}

function parseBool(raw: string | undefined): boolean | null {
  if (!raw?.trim()) return null;
  const k = key(raw);
  if (["YES", "Y", "TRUE", "1", "REQUIRED"].includes(k)) return true;
  if (["NO", "N", "FALSE", "0", "OPTIONAL"].includes(k)) return false;
  return null;
}

/** "A", "A,C", "b; d" → indexes; TRUE/FALSE handled by the caller. */
function parseLetters(raw: string): number[] | null {
  const parts = raw.split(/[,;\s]+/).filter(Boolean);
  const idx = parts.map((p) => "ABCDEF".indexOf(p.toUpperCase()));
  return idx.some((i) => i < 0 || parts.some((p) => p.length !== 1)) ? null : idx;
}

/** Interpret template rows (header first). Pure: no database access. */
export function interpretTemplateRows(table: string[][]): ParsedImport {
  const issues: ImportIssue[] = [];
  const empty: ParsedImport = { payload: { sourceFileName: null, sections: [] }, issues, sourceRows: [], summary: { rows: 0, sections: 0, questions: 0, groups: 0, invalidRows: 0 } };

  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) {
    issues.push({ row: 0, message: "The file is empty." });
    return empty;
  }
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const unknown = header.filter((h) => h && !(TEMPLATE_COLUMNS as readonly string[]).includes(h));
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    issues.push({ row: 1, message: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the question paper template.` });
    return empty;
  }
  if (unknown.length) issues.push({ row: 1, message: `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.` });
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    issues.push({ row: 0, message: `Too many rows: at most ${MAX_IMPORT_ROWS} questions per import.` });
    return empty;
  }

  const rowIssue = (row: number, field: string | undefined, message: string) => issues.push({ row, field, message });
  const invalidRows = new Set<number>();
  const fail = (row: number, field: string | undefined, message: string) => {
    rowIssue(row, field, message);
    invalidRows.add(row);
  };

  type Section = { title: string; firstRow: number; config: Record<string, unknown>; items: Item[] };
  type Question = Record<string, unknown>;
  type Item = { kind: "question"; question: Question; row: number } | { kind: "group"; key: string; group: Record<string, unknown>; children: { question: Question; row: number }[]; row: number };

  const sections = new Map<string, Section>();
  const groupOwner = new Map<string, string>();
  const seenText = new Map<string, number>();
  let dataRows = 0;

  for (let i = 1; i < table.length; i++) {
    const rowNo = i + 1;
    const cells = table[i];
    if (!cells.some((c) => c.trim() !== "")) continue;
    dataRows++;
    const r: Row = {};
    header.forEach((h, j) => {
      if ((TEMPLATE_COLUMNS as readonly string[]).includes(h)) r[h as Column] = (cells[j] ?? "").trim();
    });

    // --- section -------------------------------------------------------------
    const title = r.section ?? "";
    if (!title) {
      fail(rowNo, "section", "Section is required.");
      continue;
    }
    const sKey = title.toLowerCase();
    let section = sections.get(sKey);
    if (!section) {
      const rule = parseRule(r.section_rule);
      const required = parseBool(r.section_required);
      if (!rule) fail(rowNo, "section_rule", `Unknown attempt rule “${r.section_rule}”. Use ALL, OPTIONAL, ANY_N, EXACTLY_N, UP_TO_N or BEST_N.`);
      if (r.section_required && required === null) fail(rowNo, "section_required", "Use yes or no.");
      const config = {
        title,
        instructions: r.section_instructions ?? "",
        attemptRule: rule?.rule ?? SectionAttemptRule.ALL,
        attemptCount: r.section_count ?? "",
        isRequired: required ?? rule?.isRequired ?? true,
      };
      const check = sectionSchema.safeParse(config);
      if (!check.success) for (const iss of check.error.issues) fail(rowNo, iss.path[0] === "attemptCount" ? "section_count" : `section_${String(iss.path[0])}`, iss.message);
      section = { title, firstRow: rowNo, config, items: [] };
      sections.set(sKey, section);
    } else if ((r.section_rule && r.section_rule !== String(section.config.attemptRule) && parseRule(r.section_rule)?.rule !== section.config.attemptRule) || (r.section_count && r.section_count !== String(section.config.attemptCount))) {
      fail(rowNo, "section_rule", `Section settings differ from row ${section.firstRow}. Set them once, on the section’s first row.`);
    }

    // --- question ----------------------------------------------------------------
    const type = r.type ? TYPE_ALIASES[key(r.type)] : undefined;
    if (!type) fail(rowNo, "type", r.type ? `Unknown question type “${r.type}”.` : "Question type is required.");
    const options = OPTION_COLUMNS.map((c) => r[c] ?? "");
    const lastFilled = options.reduce((last, o, idx) => (o ? idx : last), -1);
    const filled = options.slice(0, lastFilled + 1);
    if (filled.some((o) => !o)) fail(rowNo, "options", "Fill options in order (A, B, C…) without gaps.");

    let built: Question = {
      type: type ?? r.type ?? "",
      text: r.question ?? "",
      guidance: r.guidance ?? "",
      marks: r.marks ?? "",
      negativeMarks: r.negative_marks ?? "",
      topic: r.topic ?? "",
      difficulty: r.difficulty ? key(r.difficulty) : "MEDIUM",
      options: [] as { text: string; isCorrect: boolean }[],
    };

    if (type && hasOptions(type)) {
      const correct = (r.correct ?? "").trim();
      if (type === QuestionType.TRUE_FALSE) {
        const k = key(correct);
        const isTrue = ["TRUE", "T", "A"].includes(k) ? true : ["FALSE", "F", "B"].includes(k) ? false : null;
        if (isTrue === null) fail(rowNo, "correct", "Set correct to TRUE or FALSE.");
        built = { ...built, options: [{ text: "True", isCorrect: isTrue === true }, { text: "False", isCorrect: isTrue === false }] };
      } else {
        const letters = correct ? parseLetters(correct) : [];
        if (!correct) fail(rowNo, "correct", "Set the correct answer (e.g. B, or A,C for multiple answers).");
        else if (!letters) fail(rowNo, "correct", `“${correct}” isn’t a valid answer. Use option letters, e.g. B or A,C.`);
        else if (letters.some((ix) => ix >= filled.length)) fail(rowNo, "correct", "The correct answer points to an empty option.");
        built = { ...built, options: filled.map((text, ix) => ({ text, isCorrect: !!letters?.includes(ix) })) };
      }
    }

    if (type) {
      const check = questionInputSchema.safeParse(built);
      if (!check.success) {
        for (const iss of check.error.issues) {
          const field = String(iss.path[0] ?? "");
          if (invalidRows.has(rowNo) && field === "options" && issues.some((x) => x.row === rowNo && (x.field === "correct" || x.field === "options"))) continue;
          fail(rowNo, { text: "question", negativeMarks: "negative_marks", options: "options" }[field] ?? field, iss.message);
        }
      }
    }

    const textKey = `${type ?? r.type}|${(r.question ?? "").toLowerCase().replace(/\s+/g, " ")}`;
    if (r.question) {
      const dup = seenText.get(textKey);
      if (dup) fail(rowNo, "question", `Duplicate of row ${dup}.`);
      else seenText.set(textKey, rowNo);
    }

    // --- placement: plain question or part of a group ---------------------------
    const groupKey = r.group?.trim();
    if (!groupKey) {
      section.items.push({ kind: "question", question: built, row: rowNo });
      continue;
    }
    const gKey = groupKey.toLowerCase();
    const owner = groupOwner.get(gKey);
    if (owner && owner !== sKey) {
      fail(rowNo, "group", `Group “${groupKey}” is already used in section “${sections.get(owner)?.title}”.`);
      continue;
    }
    groupOwner.set(gKey, sKey);
    let group = section.items.find((it): it is Extract<Item, { kind: "group" }> => it.kind === "group" && it.key === gKey);
    if (!group) {
      const gType = r.group_type ? key(r.group_type) : QuestionGroupType.CASE_STUDY;
      if (!(gType in QuestionGroupType)) fail(rowNo, "group_type", "Use CASE_STUDY or COMPREHENSION.");
      if (!r.group_text) fail(rowNo, "group_text", "The first row of a group needs group_text (the case or passage prompt).");
      group = { kind: "group", key: gKey, group: { groupType: gType, text: r.group_text ?? "", passage: r.passage ?? "" }, children: [], row: rowNo };
      section.items.push(group);
    }
    group.children.push({ question: built, row: rowNo });
  }

  if (dataRows === 0) issues.push({ row: 0, message: "The file has a header but no questions." });

  const list = [...sections.values()];
  const payload: ImportPayloadInput = {
    sourceFileName: null,
    sections: list.map((s) => ({
      ...(s.config as Omit<ImportPayloadInput["sections"][number], "items">),
      items: s.items.map((it) =>
        it.kind === "question"
          ? { kind: "question" as const, question: it.question as never }
          : { kind: "group" as const, group: it.group as never, children: it.children.map((c) => c.question as never) },
      ),
    })),
  };
  return {
    payload,
    issues: issues.sort((a, b) => a.row - b.row),
    sourceRows: list.map((s) => s.items.map((it) => it.row)),
    summary: {
      rows: dataRows,
      sections: list.length,
      questions: list.reduce((n, s) => n + s.items.reduce((m, it) => m + (it.kind === "group" ? it.children.length : 1), 0), 0),
      groups: list.reduce((n, s) => n + s.items.filter((it) => it.kind === "group").length, 0),
      invalidRows: invalidRows.size,
    },
  };
}
