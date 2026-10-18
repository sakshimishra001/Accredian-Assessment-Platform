import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { ResponseType, type QuestionGroupType } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError, type FieldErrors } from "@/lib/errors";
import { canEditPaper, PAPER_IN_USE_MESSAGE, paperReadinessIssues, round2, sectionMaxMarks } from "@/lib/papers/rules";
import { buildSnapshot, type QuestionSnapshot } from "@/lib/questions/snapshot";
import { createPaperSchema, groupSchema, sectionSchema, updatePaperSchema, type GroupData, type SectionData } from "@/lib/validation/paper";
import { hasOptions } from "@/lib/questions/types";
import { responseConfigSchema } from "@/lib/validation/files";
import type { QuestionData } from "@/lib/validation/question";
import { AuditAction, recordAudit } from "../audit";
import type { SessionUser } from "../auth/session";
import { assertAdmin } from "../authz";
import { db, type DbTx } from "../db";
import { deleteUnreferencedFiles } from "./files";
import { applyQuestionUpdate, insertQuestion, parseQuestion } from "./questions";

export interface GroupSnapshot {
  kind: "group";
  groupType: QuestionGroupType;
  text: string;
  passage: string | null;
}

const asJson = (v: QuestionSnapshot | GroupSnapshot) => v as unknown as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Load a paper for editing: it must exist and not be used by an assessment (no review state is
 * involved). Exported for the importer and supporting materials, which edit papers too.
 */
export async function loadEditablePaper(tx: DbTx, paperId: string) {
  const paper = await tx.questionPaper.findUnique({ where: { id: paperId }, select: { id: true, courseId: true, _count: { select: { assessments: true } } } });
  if (!paper) throw new NotFoundError("Question paper not found.");
  if (!canEditPaper(paper._count.assessments)) throw new ConflictError(PAPER_IN_USE_MESSAGE);
  return { id: paper.id, courseId: paper.courseId };
}
const loadDraft = loadEditablePaper;

async function loadDraftSection(tx: DbTx, sectionId: string) {
  const section = await tx.paperSection.findUnique({ where: { id: sectionId }, select: { id: true, paperId: true } });
  if (!section) throw new NotFoundError("Section not found.");
  const paper = await loadDraft(tx, section.paperId);
  return { section, paper };
}

async function loadDraftItem(tx: DbTx, itemId: string) {
  const item = await tx.paperQuestion.findUnique({
    where: { id: itemId },
    select: { id: true, paperId: true, sectionId: true, parentId: true, questionId: true, groupType: true },
  });
  if (!item) throw new NotFoundError("Question not found in this paper.");
  const paper = await loadDraft(tx, item.paperId);
  return { item, paper };
}

async function touch(tx: DbTx, actor: SessionUser, paperId: string, metadata: Prisma.InputJsonValue) {
  await tx.questionPaper.update({ where: { id: paperId }, data: { updatedById: actor.id } });
  await recordAudit({ actorId: actor.id, action: AuditAction.PAPER_STRUCTURE_CHANGED, entityType: "QuestionPaper", entityId: paperId, metadata }, tx);
}

// ---------------------------------------------------------------------------
// Paper CRUD
// ---------------------------------------------------------------------------

export function parsePaperDetails(raw: unknown) {
  const parsed = createPaperSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

/** Create a draft paper inside an existing transaction (shared with createPaperFromImport). */
export async function insertPaper(tx: DbTx, actorId: string, data: ReturnType<typeof parsePaperDetails>, extra: { sourceFileName?: string | null } = {}) {
  const course = await tx.course.findUnique({ where: { id: data.courseId }, select: { isActive: true } });
  if (!course) throw new ValidationError("Choose a valid course.", { courseId: ["Course not found"] });
  if (!course.isActive) throw new ValidationError("This course is inactive.", { courseId: ["Course is inactive"] });
  const paper = await tx.questionPaper.create({
    data: { ...data, sourceFileName: extra.sourceFileName ?? null, createdById: actorId },
    select: { id: true, name: true, status: true, version: true, courseId: true },
  });
  await recordAudit({ actorId, action: AuditAction.PAPER_CREATED, entityType: "QuestionPaper", entityId: paper.id, metadata: { name: paper.name } }, tx);
  return paper;
}

export async function createQuestionPaper(actor: SessionUser, raw: unknown) {
  assertAdmin(actor);
  const data = parsePaperDetails(raw);
  return db.$transaction((tx) => insertPaper(tx, actor.id, data));
}

/** Update a draft's details. The course is fixed. */
export async function updateQuestionPaper(actor: SessionUser, paperId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = updatePaperSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db.$transaction(async (tx) => {
    await loadDraft(tx, paperId);
    const paper = await tx.questionPaper.update({
      where: { id: paperId },
      data: { ...parsed.data, updatedById: actor.id },
      select: { id: true, name: true, description: true, instructions: true, subject: true, durationMinutes: true, status: true },
    });
    await recordAudit({ actorId: actor.id, action: AuditAction.PAPER_UPDATED, entityType: "QuestionPaper", entityId: paperId, metadata: { fields: Object.keys(parsed.data) } }, tx);
    return paper;
  });
}

const paperSummarySelect = {
  id: true,
  name: true,
  subject: true,
  durationMinutes: true,
  status: true,
  version: true,
  basedOnId: true,
  sourceFileName: true,
  submittedAt: true,
  reviewedAt: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
  course: { select: { id: true, code: true, name: true } },
  _count: { select: { assessments: true } },
  sections: {
    orderBy: { position: "asc" },
    select: {
      title: true,
      attemptRule: true,
      attemptCount: true,
      items: { orderBy: { position: "asc" }, select: { parentId: true, questionId: true, marks: true, children: { select: { marks: true } } } },
    },
  },
} satisfies Prisma.QuestionPaperSelect;

type SummaryRow = Prisma.QuestionPaperGetPayload<{ select: typeof paperSummarySelect }>;

/** What would make the paper unusable in an assessment (the same checks as the paper detail). */
function readinessOf(sections: SummaryRow["sections"]) {
  let n = 0;
  return paperReadinessIssues(
    sections.map((s) => ({
      title: s.title,
      attemptRule: s.attemptRule,
      attemptCount: s.attemptCount,
      items: s.items.filter((i) => i.parentId === null).map((i) => ({ kind: i.questionId ? ("question" as const) : ("group" as const), marks: itemMarks(i), childCount: i.children.length, number: String(++n) })),
    })),
  );
}

function summarize(p: SummaryRow) {
  const { sections, _count, ...rest } = p;
  let questionCount = 0;
  let totalMarks = 0;
  for (const s of sections) {
    const top = s.items.filter((i) => i.parentId === null);
    questionCount += s.items.filter((i) => i.questionId).length;
    totalMarks += sectionMaxMarks(s.attemptRule, s.attemptCount, top.map(itemMarks));
  }
  const issues = readinessOf(sections);
  return {
    ...rest,
    sectionCount: sections.length,
    questionCount,
    totalMarks: round2(totalMarks),
    /** Assessments using this paper; while any do, it can't be edited (create a new version instead). */
    assessmentCount: _count.assessments,
    inUse: _count.assessments > 0,
    /** Complete: can be selected in the Assessment Builder (no approval needed). */
    ready: issues.length === 0,
    issues,
  };
}

function itemMarks(i: { questionId: string | null; marks: Prisma.Decimal | null; children: { marks: Prisma.Decimal | null }[] }) {
  return i.questionId ? (i.marks?.toNumber() ?? 0) : i.children.reduce((n, c) => n + (c.marks?.toNumber() ?? 0), 0);
}

/** All papers (admin), with whether each is complete and whether an assessment uses it. */
export async function listQuestionPapers(actor: SessionUser, filters: { courseId?: string; q?: string } = {}) {
  assertAdmin(actor);
  const q = filters.q?.trim();
  const rows = await db.questionPaper.findMany({
    where: {
      ...(filters.courseId ? { courseId: filters.courseId } : {}),
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 200,
    select: paperSummarySelect,
  });
  return rows.map(summarize);
}

/**
 * The papers the Assessment Builder may choose from: every saved paper that is complete — no review
 * or approval involved. Incomplete papers are left out (they'd give an assessment nothing valid to run).
 */
export async function listSelectablePapers(actor: SessionUser, filters: { courseId?: string } = {}) {
  assertAdmin(actor);
  const rows = await db.questionPaper.findMany({
    where: filters.courseId ? { courseId: filters.courseId } : {},
    orderBy: [{ updatedAt: "desc" }],
    select: paperSummarySelect,
  });
  return rows.map(summarize).filter((p) => p.ready);
}

/** For the Assessment Builder's server-side check: the paper's course and what (if anything) makes it unusable. */
export async function paperUsability(tx: DbTx, paperId: string) {
  const row = await tx.questionPaper.findUnique({ where: { id: paperId }, select: paperSummarySelect });
  return row ? { courseId: row.course.id, issues: summarize(row).issues } : null;
}

// ---------------------------------------------------------------------------
// Paper detail (the tree reviewers and, later, assessments consume)
// ---------------------------------------------------------------------------

const itemSelect = {
  id: true,
  position: true,
  parentId: true,
  questionId: true,
  groupType: true,
  marks: true,
  negativeMarks: true,
  snapshot: true,
  questionVersion: true,
  responseType: true,
  allowedFileTypes: true,
  maxFileSizeMb: true,
  maxFiles: true,
  fileRequired: true,
  materials: { orderBy: { position: "asc" }, select: { id: true, description: true, file: { select: { id: true, fileName: true, extension: true, sizeBytes: true } } } },
} satisfies Prisma.PaperQuestionSelect;

type ItemRow = Prisma.PaperQuestionGetPayload<{ select: typeof itemSelect }>;

export interface PaperQuestionItem {
  kind: "question";
  id: string;
  number: string;
  position: number;
  questionId: string;
  questionVersion: number;
  marks: number;
  negativeMarks: number;
  question: QuestionSnapshot;
  /** How learners answer (written questions); objective questions are always TEXT. */
  response: { type: ResponseType; allowedFileTypes: string[]; maxFileSizeMb: number; maxFiles: number; fileRequired: boolean };
  materials: PaperMaterial[];
}

/** A supporting material attached to a question or case/passage (metadata only). */
export interface PaperMaterial {
  id: string;
  description: string | null;
  file: { id: string; fileName: string; extension: string; sizeBytes: number };
}

export interface PaperGroupItem {
  kind: "group";
  id: string;
  number: string;
  position: number;
  groupType: QuestionGroupType;
  text: string;
  passage: string | null;
  marks: number;
  materials: PaperMaterial[];
  children: PaperQuestionItem[];
}

function toQuestionItem(row: ItemRow, number: string): PaperQuestionItem {
  return {
    kind: "question",
    id: row.id,
    number,
    position: row.position,
    questionId: row.questionId!,
    questionVersion: row.questionVersion ?? 1,
    marks: row.marks?.toNumber() ?? 0,
    negativeMarks: row.negativeMarks.toNumber(),
    question: row.snapshot as unknown as QuestionSnapshot,
    response: { type: row.responseType, allowedFileTypes: row.allowedFileTypes, maxFileSizeMb: row.maxFileSizeMb, maxFiles: row.maxFiles, fileRequired: row.fileRequired },
    materials: row.materials,
  };
}

export async function getQuestionPaper(actor: SessionUser, paperId: string) {
  assertAdmin(actor);
  const paper = await db.questionPaper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      name: true,
      description: true,
      instructions: true,
      subject: true,
      durationMinutes: true,
      status: true,
      version: true,
      sourceFileName: true,
      submittedAt: true,
      reviewedAt: true,
      reviewNote: true,
      approvedAt: true,
      createdAt: true,
      updatedAt: true,
      course: { select: { id: true, code: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
      basedOn: { select: { id: true, version: true } },
      _count: { select: { assessments: true } },
      sections: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          title: true,
          instructions: true,
          position: true,
          isRequired: true,
          attemptRule: true,
          attemptCount: true,
          items: { orderBy: { position: "asc" }, select: itemSelect },
        },
      },
    },
  });
  if (!paper) throw new NotFoundError("Question paper not found.");

  let n = 0;
  const sections = paper.sections.map((s) => {
    const top = s.items.filter((i) => i.parentId === null);
    const items = top.map((row): PaperQuestionItem | PaperGroupItem => {
      const number = String(++n);
      if (row.questionId) return toQuestionItem(row, number);
      const snap = row.snapshot as unknown as GroupSnapshot;
      const children = s.items.filter((c) => c.parentId === row.id).map((c, idx) => toQuestionItem(c, `${number}(${String.fromCharCode(97 + idx)})`));
      return {
        kind: "group",
        id: row.id,
        number,
        position: row.position,
        groupType: row.groupType!,
        text: snap.text,
        passage: snap.passage,
        marks: round2(children.reduce((m, c) => m + c.marks, 0)),
        materials: row.materials,
        children,
      };
    });
    const maxMarks = sectionMaxMarks(s.attemptRule, s.attemptCount, items.map((i) => i.marks));
    return { ...s, items, itemCount: items.length, maxMarks };
  });

  const issues = paperReadinessIssues(
    sections.map((s) => ({
      title: s.title,
      attemptRule: s.attemptRule,
      attemptCount: s.attemptCount,
      items: s.items.map((i) => ({ kind: i.kind, marks: i.marks, childCount: i.kind === "group" ? i.children.length : 0, number: i.number })),
    })),
  );
  const questionCount = sections.reduce((m, s) => m + s.items.reduce((k, i) => k + (i.kind === "group" ? i.children.length : 1), 0), 0);
  const { _count, ...rest } = paper;
  return {
    ...rest,
    sections,
    questionCount,
    totalMarks: round2(sections.reduce((m, s) => m + s.maxMarks, 0)),
    /** Problems that make the paper unusable in an assessment; empty when it is ready to be selected. */
    issues,
    assessmentCount: _count.assessments,
    /** Used by an assessment: read-only (create a new version to change it). */
    inUse: _count.assessments > 0,
  };
}

export type QuestionPaperDetail = Awaited<ReturnType<typeof getQuestionPaper>>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function parseSection(raw: unknown): SectionData {
  const parsed = sectionSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

/** Insert a section at the end of a paper (inside a transaction). */
export async function insertSection(tx: DbTx, paperId: string, data: SectionData) {
  const last = await tx.paperSection.aggregate({ where: { paperId }, _max: { position: true } });
  return tx.paperSection.create({
    data: { paperId, ...data, attemptCount: data.attemptCount ?? null, position: (last._max.position ?? 0) + 1 },
    select: { id: true, title: true, position: true, isRequired: true, attemptRule: true, attemptCount: true, instructions: true },
  });
}

export async function addSection(actor: SessionUser, paperId: string, raw: unknown) {
  assertAdmin(actor);
  const data = parseSection(raw);
  return db.$transaction(async (tx) => {
    await loadDraft(tx, paperId);
    const section = await insertSection(tx, paperId, data);
    await touch(tx, actor, paperId, { op: "section_added", sectionId: section.id });
    return section;
  });
}

/** Replace a section's configuration (title, instructions, required, attempt rule). */
export async function updateSection(actor: SessionUser, sectionId: string, raw: unknown) {
  assertAdmin(actor);
  const data = parseSection(raw);
  return db.$transaction(async (tx) => {
    const { paper } = await loadDraftSection(tx, sectionId);
    const section = await tx.paperSection.update({
      where: { id: sectionId },
      data: { ...data, attemptCount: data.attemptCount ?? null },
      select: { id: true, title: true, position: true, isRequired: true, attemptRule: true, attemptCount: true, instructions: true },
    });
    await touch(tx, actor, paper.id, { op: "section_updated", sectionId });
    return section;
  });
}

/** Stored files attached (as materials) to the given paper items. */
async function materialFileIds(tx: DbTx, where: Prisma.PaperQuestionWhereInput) {
  return (await tx.paperQuestionMaterial.findMany({ where: { paperQuestion: where }, select: { fileId: true } })).map((m) => m.fileId);
}

/**
 * Remove a section and its items from the paper. Bank questions are kept; the items' supporting
 * materials go with them, and their stored files are deleted unless another paper version uses them.
 */
export async function removeSection(actor: SessionUser, sectionId: string) {
  assertAdmin(actor);
  const fileIds = await db.$transaction(async (tx) => {
    const { paper } = await loadDraftSection(tx, sectionId);
    const fileIds = await materialFileIds(tx, { sectionId });
    await tx.paperQuestion.deleteMany({ where: { sectionId, parentId: { not: null } } });
    await tx.paperSection.delete({ where: { id: sectionId } });
    const rest = await tx.paperSection.findMany({ where: { paperId: paper.id }, orderBy: { position: "asc" }, select: { id: true } });
    for (const [i, s] of rest.entries()) await tx.paperSection.update({ where: { id: s.id }, data: { position: i + 1 } });
    await touch(tx, actor, paper.id, { op: "section_removed", sectionId, ...(fileIds.length ? { materialFiles: fileIds } : {}) });
    return fileIds;
  });
  await deleteUnreferencedFiles(fileIds, actor.id);
}

/** Set the order of all sections of a paper. `sectionIds` must list each section exactly once. */
export async function reorderSections(actor: SessionUser, paperId: string, sectionIds: string[]) {
  assertAdmin(actor);
  await db.$transaction(async (tx) => {
    await loadDraft(tx, paperId);
    const current = await tx.paperSection.findMany({ where: { paperId }, select: { id: true } });
    assertSameSet(current.map((s) => s.id), sectionIds, "sections");
    for (const [i, id] of sectionIds.entries()) await tx.paperSection.update({ where: { id }, data: { position: i + 1 } });
    await touch(tx, actor, paperId, { op: "sections_reordered" });
  });
}

function assertSameSet(current: string[], proposed: string[], what: string) {
  const a = [...current].sort();
  const b = [...proposed].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new ValidationError(`Provide every one of the ${what}, each exactly once.`);
}

// ---------------------------------------------------------------------------
// Questions and groups
// ---------------------------------------------------------------------------

async function nextPosition(tx: DbTx, sectionId: string, parentId: string | null) {
  const last = await tx.paperQuestion.aggregate({ where: { sectionId, parentId }, _max: { position: true } });
  return (last._max.position ?? 0) + 1;
}

async function renumber(tx: DbTx, sectionId: string, parentId: string | null) {
  const rows = await tx.paperQuestion.findMany({ where: { sectionId, parentId }, orderBy: { position: "asc" }, select: { id: true } });
  for (const [i, r] of rows.entries()) await tx.paperQuestion.update({ where: { id: r.id }, data: { position: i + 1 } });
}

/**
 * Create a bank question (in the paper's course) and place it in a section, optionally inside a
 * group, with a frozen snapshot. Used by the editor and by imports.
 */
export async function insertPaperQuestion(
  tx: DbTx,
  actorId: string,
  paper: { id: string; courseId: string },
  sectionId: string,
  parentId: string | null,
  data: QuestionData,
) {
  const question = await insertQuestion(tx, actorId, { ...data, courseId: paper.courseId });
  return tx.paperQuestion.create({
    data: {
      paperId: paper.id,
      sectionId,
      parentId,
      position: await nextPosition(tx, sectionId, parentId),
      questionId: question.id,
      marks: data.marks,
      negativeMarks: data.negativeMarks,
      snapshot: asJson(buildSnapshot(question)),
      questionVersion: question.version,
    },
    select: { id: true, questionId: true, position: true },
  });
}

export async function insertPaperGroup(tx: DbTx, paperId: string, sectionId: string, data: GroupData) {
  const snapshot: GroupSnapshot = { kind: "group", groupType: data.groupType, text: data.text, passage: data.passage };
  return tx.paperQuestion.create({
    data: { paperId, sectionId, parentId: null, position: await nextPosition(tx, sectionId, null), groupType: data.groupType, snapshot: asJson(snapshot) },
    select: { id: true, position: true },
  });
}

/**
 * The learner response configuration sent with a question (`raw.response`), validated. Objective
 * questions are always answered by choosing options, so their configuration is reset to TEXT.
 * Returns undefined when no configuration was sent (the stored one is kept).
 */
function parseResponse(raw: unknown, type: string) {
  const input = (raw as { response?: unknown } | null)?.response;
  if (hasOptions(type as QuestionSnapshot["type"])) return input === undefined ? undefined : { responseType: ResponseType.TEXT, allowedFileTypes: [], fileRequired: false };
  if (input === undefined) return undefined;
  const parsed = responseConfigSchema.safeParse(input);
  if (!parsed.success) {
    const errors: FieldErrors = {};
    for (const i of parsed.error.issues) (errors[`response.${i.path.join(".")}`] ??= []).push(i.message);
    throw new ValidationError("Please correct the highlighted fields.", errors);
  }
  const v = parsed.data;
  return { responseType: v.type, allowedFileTypes: v.allowedFileTypes, maxFileSizeMb: v.maxFileSizeMb, maxFiles: v.maxFiles, fileRequired: v.fileRequired };
}

/** Add a new question to a section, or (with `parentId`) as a sub-question of a group. */
export async function addPaperQuestion(actor: SessionUser, sectionId: string, raw: unknown, options: { parentId?: string } = {}) {
  assertAdmin(actor);
  const data = parseQuestion(raw);
  const response = parseResponse(raw, data.type);
  return db.$transaction(async (tx) => {
    const { paper } = await loadDraftSection(tx, sectionId);
    const parentId = options.parentId ?? null;
    if (parentId) {
      const parent = await tx.paperQuestion.findUnique({ where: { id: parentId }, select: { sectionId: true, groupType: true, parentId: true } });
      if (!parent || parent.sectionId !== sectionId) throw new NotFoundError("Case/passage not found in this section.");
      if (!parent.groupType || parent.parentId) throw new ValidationError("Sub-questions can only be added to a case study or comprehension.");
    }
    const item = await insertPaperQuestion(tx, actor.id, paper, sectionId, parentId, data);
    if (response) await tx.paperQuestion.update({ where: { id: item.id }, data: response });
    await touch(tx, actor, paper.id, { op: "question_added", itemId: item.id });
    return item;
  });
}

/** Add a case study / comprehension (context + sub-questions added separately). */
export async function addPaperGroup(actor: SessionUser, sectionId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = groupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db.$transaction(async (tx) => {
    const { paper } = await loadDraftSection(tx, sectionId);
    const item = await insertPaperGroup(tx, paper.id, sectionId, parsed.data);
    await touch(tx, actor, paper.id, { op: "group_added", itemId: item.id });
    return item;
  });
}

/**
 * Edit a question in a draft paper. Uses the existing bank update (version bumped only when
 * content changes) and refreshes this paper's snapshot. Snapshots in other papers — notably
 * approved ones — are left exactly as they were.
 */
export async function updatePaperQuestion(actor: SessionUser, itemId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = parseQuestion(raw);
  const response = parseResponse(raw, parsed.type);
  return db.$transaction(async (tx) => {
    const { item, paper } = await loadDraftItem(tx, itemId);
    if (!item.questionId) throw new ValidationError("This item is a case/passage, not a question.");
    const question = await applyQuestionUpdate(tx, actor.id, item.questionId, { ...parsed, courseId: paper.courseId });
    const updated = await tx.paperQuestion.update({
      where: { id: itemId },
      data: { marks: parsed.marks, negativeMarks: parsed.negativeMarks, snapshot: asJson(buildSnapshot(question)), questionVersion: question.version, ...(response ?? {}) },
      select: { id: true, questionVersion: true },
    });
    await touch(tx, actor, paper.id, { op: "question_updated", itemId, questionVersion: question.version });
    return updated;
  });
}

export async function updatePaperGroup(actor: SessionUser, itemId: string, raw: unknown) {
  assertAdmin(actor);
  const parsed = groupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return db.$transaction(async (tx) => {
    const { item, paper } = await loadDraftItem(tx, itemId);
    if (!item.groupType) throw new ValidationError("This item is a question, not a case/passage.");
    const snapshot: GroupSnapshot = { kind: "group", ...parsed.data };
    await tx.paperQuestion.update({ where: { id: itemId }, data: { groupType: parsed.data.groupType, snapshot: asJson(snapshot) } });
    await touch(tx, actor, paper.id, { op: "group_updated", itemId });
  });
}

/**
 * Remove an item (a group takes its sub-questions with it). Bank questions are kept; supporting
 * materials go with the item, and their stored files are deleted unless another paper version uses them.
 */
export async function removePaperItem(actor: SessionUser, itemId: string) {
  assertAdmin(actor);
  const fileIds = await db.$transaction(async (tx) => {
    const { item, paper } = await loadDraftItem(tx, itemId);
    const scope = { OR: [{ id: itemId }, { parentId: itemId }] };
    const fileIds = await materialFileIds(tx, scope);
    await tx.paperQuestion.deleteMany({ where: scope });
    await renumber(tx, item.sectionId, item.parentId);
    await touch(tx, actor, paper.id, { op: "item_removed", itemId, ...(fileIds.length ? { materialFiles: fileIds } : {}) });
    return fileIds;
  });
  await deleteUnreferencedFiles(fileIds, actor.id);
}

/** Set the order of the items at one level: a section's top level, or a group's sub-questions. */
export async function reorderPaperItems(actor: SessionUser, sectionId: string, parentId: string | null, itemIds: string[]) {
  assertAdmin(actor);
  await db.$transaction(async (tx) => {
    const { paper } = await loadDraftSection(tx, sectionId);
    const current = await tx.paperQuestion.findMany({ where: { sectionId, parentId }, select: { id: true } });
    assertSameSet(current.map((c) => c.id), itemIds, "questions at this level");
    for (const [i, id] of itemIds.entries()) await tx.paperQuestion.update({ where: { id }, data: { position: i + 1 } });
    await touch(tx, actor, paper.id, { op: "items_reordered", sectionId, parentId });
  });
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Start a new version of a paper an assessment uses: an editable copy (version + 1) with the same
 * sections and items, including their frozen snapshots. The paper in use is never modified.
 */
export async function createPaperRevision(actor: SessionUser, paperId: string) {
  assertAdmin(actor);
  return db.$transaction(async (tx) => {
    const source = await tx.questionPaper.findUnique({
      where: { id: paperId },
      include: { sections: { orderBy: { position: "asc" }, include: { items: { orderBy: [{ parentId: "asc" }, { position: "asc" }], include: { materials: true } } } } },
    });
    if (!source) throw new NotFoundError("Question paper not found.");
    if (canEditPaper(await tx.assessment.count({ where: { paperId } }))) throw new ConflictError("This paper isn’t used by any assessment yet. Edit it directly.");
    const newer = await tx.questionPaper.findFirst({ where: { basedOnId: paperId }, select: { version: true } });
    if (newer) throw new ConflictError(`Version ${newer.version} of this paper already exists. Continue with that version.`);

    const copy = await tx.questionPaper.create({
      data: {
        name: source.name,
        description: source.description,
        instructions: source.instructions,
        courseId: source.courseId,
        subject: source.subject,
        durationMinutes: source.durationMinutes,
        sourceFileName: source.sourceFileName,
        version: source.version + 1,
        basedOnId: source.id,
        createdById: actor.id,
      },
      select: { id: true, name: true, status: true, version: true, basedOnId: true },
    });
    for (const s of source.sections) {
      const section = await tx.paperSection.create({
        data: {
          paperId: copy.id,
          title: s.title,
          instructions: s.instructions,
          position: s.position,
          isRequired: s.isRequired,
          attemptRule: s.attemptRule,
          attemptCount: s.attemptCount,
        },
      });
      const idMap = new Map<string, string>();
      // Parents (parentId null) are ordered first, so children can point at their copied parent.
      for (const it of [...s.items].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null))) {
        const created = await tx.paperQuestion.create({
          data: {
            paperId: copy.id,
            sectionId: section.id,
            parentId: it.parentId ? idMap.get(it.parentId)! : null,
            position: it.position,
            questionId: it.questionId,
            groupType: it.groupType,
            marks: it.marks,
            negativeMarks: it.negativeMarks,
            snapshot: it.snapshot as Prisma.InputJsonValue,
            questionVersion: it.questionVersion,
            responseType: it.responseType,
            allowedFileTypes: it.allowedFileTypes,
            maxFileSizeMb: it.maxFileSizeMb,
            maxFiles: it.maxFiles,
            fileRequired: it.fileRequired,
            // Materials are shared by reference: the same stored file, a new attachment row.
            materials: { create: it.materials.map((m) => ({ fileId: m.fileId, description: m.description, position: m.position })) },
          },
          select: { id: true },
        });
        idMap.set(it.id, created.id);
      }
    }
    await recordAudit(
      { actorId: actor.id, action: AuditAction.PAPER_REVISION_CREATED, entityType: "QuestionPaper", entityId: copy.id, metadata: { basedOnId: source.id, version: copy.version } },
      tx,
    );
    return copy;
  });
}
