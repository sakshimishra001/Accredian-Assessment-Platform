"use server";

import { revalidatePath } from "next/cache";
import { Role } from "@/lib/auth/rbac";
import { ValidationError } from "@/lib/errors";
import type { ImportIssue, ParsedImport } from "@/lib/papers/import-template";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { removeMaterial } from "../services/files";
import { createPaperFromImport, parseQuestionImport, saveImportToPaper } from "../services/question-import";
import {
  addPaperGroup,
  addPaperQuestion,
  addSection,
  createPaperRevision,
  createQuestionPaper,
  removePaperItem,
  removeSection,
  reorderPaperItems,
  reorderSections,
  updatePaperGroup,
  updatePaperQuestion,
  updateQuestionPaper,
  updateSection,
} from "../services/question-papers";

/*
 * Question Paper actions. Each checks the session and role first (requireRole redirects otherwise;
 * it stays outside runAction so the redirect isn't swallowed), then calls the existing domain
 * service, which re-checks the role and owns every business rule. Admins build papers; a saved,
 * complete paper is usable in assessments straight away (there is no review or approval).
 */

const LIBRARY = "/admin/import-questions";

function refresh(paperId?: string) {
  revalidatePath(LIBRARY);
  // A saved paper is offered in the Assessment Builder straight away.
  revalidatePath("/admin/assessments/new");
  if (paperId) {
    revalidatePath(`${LIBRARY}/${paperId}`);
    revalidatePath(`${LIBRARY}/${paperId}/edit`);
  }
}

async function done<T>(paperId: string | undefined, result: ActionResult<T>) {
  if (result.ok) refresh(paperId);
  return result;
}

interface ImportFile {
  fileName: string;
  content: string;
}

export type ImportPreview = Pick<ParsedImport, "summary" | "issues"> & {
  fileName: string;
  sections: { title: string; questions: number }[];
};

function preview(parsed: ReturnType<typeof parseQuestionImport>): ImportPreview {
  return {
    fileName: parsed.fileName,
    summary: parsed.summary,
    issues: parsed.issues,
    sections: parsed.payload.sections.map((s) => ({
      title: s.title,
      questions: s.items.reduce((n, it) => n + (it.kind === "group" ? it.children.length : 1), 0),
    })),
  };
}

/**
 * Parse on the server and refuse to save while any row has a problem — invalid rows never become
 * questions. Returns the validated payload for saving.
 */
function parseForSave(actor: Parameters<typeof parseQuestionImport>[0], file: ImportFile) {
  const parsed = parseQuestionImport(actor, file);
  if (parsed.issues.length) {
    throw new ValidationError(`${parsed.issues.length} problem${parsed.issues.length === 1 ? "" : "s"} in ${parsed.fileName}. Fix the file and upload it again.`, {
      rows: parsed.issues.map(formatIssue),
    });
  }
  return { ...parsed.payload, sourceFileName: parsed.fileName };
}

const formatIssue = (i: ImportIssue) => `${i.row ? `Row ${i.row}` : "File"}${i.field ? ` · ${i.field}` : ""}: ${i.message}`;

// --- Import -------------------------------------------------------------------

/** Upload → Parse → Validate: a preview with every row problem. Writes nothing. */
export async function previewImportAction(file: ImportFile): Promise<ActionResult<ImportPreview>> {
  const actor = await requireRole(Role.ADMIN);
  return runAction(async () => preview(parseQuestionImport(actor, file)));
}

/** Create a draft paper and import its questions from the file, in one transaction. */
export async function createPaperFromImportAction(details: unknown, file: ImportFile): Promise<ActionResult<{ id: string; questionsAdded: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const { paper, summary } = await createPaperFromImport(actor, details, parseForSave(actor, file));
    return { id: paper.id, questionsAdded: summary.questionsAdded };
  });
  return done(result.ok ? result.data?.id : undefined, result);
}

/** Import more questions from a file into an existing draft paper (all-or-nothing). */
export async function importIntoPaperAction(paperId: string, file: ImportFile): Promise<ActionResult<{ sectionsCreated: number; questionsAdded: number; groupsAdded: number }>> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(() => saveImportToPaper(actor, paperId, parseForSave(actor, file))));
}

// --- Paper --------------------------------------------------------------------

export async function createPaperAction(details: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ id: (await createQuestionPaper(actor, details)).id }));
  return done(result.ok ? result.data?.id : undefined, result);
}

export async function updatePaperAction(paperId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await updateQuestionPaper(actor, paperId, input))));
}

/** Start a new version of a paper an assessment uses; the paper in use is never modified. */
export async function createRevisionAction(paperId: string): Promise<ActionResult<{ id: string; version: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const copy = await createPaperRevision(actor, paperId);
    return { id: copy.id, version: copy.version };
  });
  if (result.ok) refresh(result.data!.id);
  return done(paperId, result);
}

// --- Sections -----------------------------------------------------------------

export async function addSectionAction(paperId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await addSection(actor, paperId, input))));
}

export async function updateSectionAction(paperId: string, sectionId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await updateSection(actor, sectionId, input))));
}

export async function removeSectionAction(paperId: string, sectionId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await removeSection(actor, sectionId))));
}

export async function reorderSectionsAction(paperId: string, sectionIds: string[]): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await reorderSections(actor, paperId, sectionIds))));
}

// --- Questions and case/passage groups ------------------------------------------------

export async function addQuestionAction(paperId: string, sectionId: string, input: unknown, parentId?: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await addPaperQuestion(actor, sectionId, input, { parentId }))));
}

export async function addGroupAction(paperId: string, sectionId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await addPaperGroup(actor, sectionId, input))));
}

export async function updateQuestionAction(paperId: string, itemId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await updatePaperQuestion(actor, itemId, input))));
}

export async function updateGroupAction(paperId: string, itemId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await updatePaperGroup(actor, itemId, input))));
}

export async function removeItemAction(paperId: string, itemId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await removePaperItem(actor, itemId))));
}

export async function reorderItemsAction(paperId: string, sectionId: string, parentId: string | null, itemIds: string[]): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await reorderPaperItems(actor, sectionId, parentId, itemIds))));
}

// --- Supporting materials -----------------------------------------------------------
// (Uploads go through POST /api/files/materials, which is not limited by the server-action body size.)

/** Remove a supporting material from a question of a draft paper. */
export async function removeMaterialAction(paperId: string, materialId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(paperId, await runAction(async () => void (await removeMaterial(actor, materialId))));
}
