"use server";

import { revalidatePath } from "next/cache";
import { MAX_LEARNER_CSV_BYTES, parseLearnerCsv } from "@/lib/academic/learner-csv";
import { Role } from "@/lib/auth/rbac";
import { ValidationError } from "@/lib/errors";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { createBatch, createBatchWithLearners, setBatchActive, updateBatch } from "../services/batches";
import { createCourse, setCourseActive, updateCourse } from "../services/courses";
import { addLearner, importLearnersToBatch, removeLearnerFromBatch, setLearnerStatus, type LearnerImportSummary } from "../services/learners";

/*
 * Admin actions for Courses, Batches and Learners. Each one checks the session and the ADMIN role
 * (requireRole redirects otherwise — kept outside runAction so the redirect isn't swallowed), then
 * calls the existing domain service, which checks the role again. Business rules and validation
 * live in the services; these only translate results and refresh the affected pages.
 */

const COURSES = "/admin/courses";
const BATCHES = "/admin/batches";

function refreshAcademic(batchId?: string) {
  revalidatePath(COURSES);
  revalidatePath(BATCHES);
  if (batchId) revalidatePath(`${BATCHES}/${batchId}`);
}

// --- Courses ------------------------------------------------------------------

export async function createCourseAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ id: (await createCourse(actor, input)).id }));
  if (result.ok) refreshAcademic();
  return result;
}

export async function updateCourseAction(courseId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await updateCourse(actor, courseId, input)));
  if (result.ok) refreshAcademic();
  return result;
}

export async function setCourseActiveAction(courseId: string, active: boolean): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await setCourseActive(actor, courseId, active)));
  if (result.ok) refreshAcademic();
  return result;
}

// --- Batches ------------------------------------------------------------------

interface CsvFile {
  fileName: string;
  content: string;
}

/** Server-side CSV reading for learner imports (size limit, name/email columns). */
function readLearnerCsv(file: CsvFile) {
  if (!/\.csv$/i.test(file.fileName)) throw new ValidationError("Upload a .csv file.", { csv: ["Only .csv files are supported"] });
  if (Buffer.byteLength(file.content, "utf8") > MAX_LEARNER_CSV_BYTES) throw new ValidationError("The file is larger than 1 MB.", { csv: ["File too large"] });
  const { rows, error } = parseLearnerCsv(file.content);
  if (error) throw new ValidationError(error, { csv: [error] });
  return rows;
}

/**
 * Create a batch. With a learner CSV, the batch and its learners are created together — if any
 * row is invalid, nothing is created.
 */
export async function createBatchAction(input: unknown, csv?: CsvFile | null): Promise<ActionResult<{ id: string; learners: LearnerImportSummary | null }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    if (csv) {
      const rows = readLearnerCsv(csv);
      const { batch, learners } = (await createBatchWithLearners(actor, input, rows))!;
      return { id: batch.id, learners };
    }
    return { id: (await createBatch(actor, input))!.id, learners: null };
  });
  if (result.ok) refreshAcademic(result.data?.id);
  return result;
}

export async function updateBatchAction(batchId: string, input: unknown): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await updateBatch(actor, batchId, input)));
  if (result.ok) refreshAcademic(batchId);
  return result;
}

export async function setBatchActiveAction(batchId: string, active: boolean): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await setBatchActive(actor, batchId, active)));
  if (result.ok) refreshAcademic(batchId);
  return result;
}

// --- Learners -----------------------------------------------------------------

/** Add one learner (name + email) to a batch: creates the LEARNER account or reuses an existing one. No password is created. */
export async function addLearnerAction(input: { name: string; email: string; batchId: string }): Promise<ActionResult<{ created: boolean; name: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const { learner, created } = await addLearner(actor, input);
    return { created, name: learner.name };
  });
  if (result.ok) refreshAcademic(input.batchId);
  return result;
}

/** Import learners from a CSV (name,email) into a batch, all-or-nothing. */
export async function importLearnersAction(batchId: string, csv: CsvFile): Promise<ActionResult<LearnerImportSummary>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => importLearnersToBatch(actor, batchId, readLearnerCsv(csv)));
  if (result.ok) refreshAcademic(batchId);
  return result;
}

/** Remove a learner from this batch only. Their account and other batch memberships stay. */
export async function removeLearnerFromBatchAction(batchId: string, learnerId: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await removeLearnerFromBatch(actor, batchId, learnerId)));
  if (result.ok) refreshAcademic(batchId);
  return result;
}

/** Enable or disable a learner's account platform-wide (all batches, all assessments). */
export async function setLearnerStatusAction(learnerId: string, status: "ACTIVE" | "DISABLED", batchId?: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await setLearnerStatus(actor, learnerId, status)));
  if (result.ok) refreshAcademic(batchId);
  return result;
}
