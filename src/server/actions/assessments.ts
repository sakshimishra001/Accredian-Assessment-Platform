"use server";

import { revalidatePath } from "next/cache";
import { AssessmentStatus } from "@/generated/prisma/enums";
import { Role } from "@/lib/auth/rbac";
import { runAction, type ActionResult } from "../action-result";
import { requireRole } from "../auth/guards";
import { createAssessment, publishAssessmentForBatch, transitionAssessment, updateAssessment } from "../services/assessments";
import { notify, scheduleOf } from "../services/communication";
import { pauseAssessment, resumeAssessment } from "../services/assessment-pause";
import { extendAttempt, extendAttempts } from "../services/attempt-extension";
import { terminateAllActiveAttempts, terminateAttempt } from "../services/attempt-termination";
import { issueLearnerPasswords } from "../services/learner-passwords";

/*
 * Assessment Builder actions. Each checks the session and the ADMIN role first (requireRole
 * redirects otherwise; it stays outside runAction so the redirect isn't swallowed), then calls the
 * existing assessment service, which re-checks the role and owns every rule: field validation,
 * approved-paper and batch checks, per-status edit locks and lifecycle transitions.
 */

const LIST = "/admin/assessments";

function refresh(id?: string) {
  revalidatePath(LIST);
  revalidatePath(`${LIST}/new`);
  if (id) revalidatePath(`${LIST}/${id}`);
}

async function done<T>(id: string | undefined, result: ActionResult<T>) {
  if (result.ok) refresh(id);
  return result;
}

/**
 * Save the wizard: creates the draft on first save, then updates it. Only fields present in
 * `input` are changed; the service rejects changes the current status locks.
 */
export async function saveAssessmentAction(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const before = id ? await scheduleOf(id) : null;
  const result = await runAction(async () => ({ id: (id ? await updateAssessment(actor, id, input) : await createAssessment(actor, input)).id }));
  // A published assessment whose window moved: tell its learners (if the Rescheduled email is on).
  if (result.ok && before && (before.status === "SCHEDULED" || before.status === "ACTIVE")) {
    const after = await scheduleOf(result.data!.id);
    if (after && (after.startAt.getTime() !== before.startAt.getTime() || after.endAt.getTime() !== before.endAt.getTime())) await notify(result.data!.id, "RESCHEDULED", actor.id);
  }
  return done(result.ok ? result.data!.id : undefined, result);
}

/** Review & Publish: DRAFT → SCHEDULED through the lifecycle, assigning the batch's learners as candidates. */
export async function publishAssessmentAction(id: string): Promise<ActionResult<{ candidatesAdded: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ candidatesAdded: (await publishAssessmentForBatch(actor, id)).candidatesAdded }));
  if (result.ok) await notify(id, "ASSIGNMENT", actor.id);
  return done(id, result);
}

/** Pause a live assessment: running attempts stop (no answering or submitting) and their timers freeze. */
export async function pauseAssessmentAction(id: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await pauseAssessment(actor, id)));
  if (result.ok) revalidatePath("/learner", "layout");
  return done(id, result);
}

/** Resume a paused assessment: learners continue with the time they had left. */
export async function resumeAssessmentAction(id: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await resumeAssessment(actor, id)));
  if (result.ok) revalidatePath("/learner", "layout");
  return done(id, result);
}

/** Terminate one learner's running attempt (a reason is required; the learner never sees it). */
export async function terminateAttemptAction(assessmentId: string, attemptId: string, reason: string): Promise<ActionResult<{ learnerName: string }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ learnerName: (await terminateAttempt(actor, { assessmentId, attemptId, reason })).learnerName }));
  if (result.ok) {
    revalidatePath("/learner", "layout");
    revalidatePath("/admin/results", "layout");
  }
  return done(assessmentId, result);
}

/** Terminate every attempt of the assessment that is in progress right now. */
export async function terminateAllActiveAttemptsAction(assessmentId: string, reason: string): Promise<ActionResult<{ terminated: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ terminated: (await terminateAllActiveAttempts(actor, { assessmentId, reason })).terminated }));
  if (result.ok) {
    revalidatePath("/learner", "layout");
    revalidatePath("/admin/results", "layout");
  }
  return done(assessmentId, result);
}

/** Give one learner's running attempt extra time (minutes and a reason are required). */
export async function extendAttemptAction(assessmentId: string, attemptId: string, minutes: number, reason: string): Promise<ActionResult<{ newEndAt: Date }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => ({ newEndAt: (await extendAttempt(actor, { assessmentId, attemptId, minutes, reason })).newEndAt }));
  if (result.ok) revalidatePath("/learner", "layout");
  return done(assessmentId, result);
}

/** Give extra time to the selected learners' attempts, or to everyone in the batch taking it now. */
export async function extendAttemptsAction(
  assessmentId: string,
  input: { scope: "SELECTED" | "BATCH"; attemptIds?: string[]; minutes: number; reason: string },
): Promise<ActionResult<{ extended: number; skipped: number }>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => {
    const r = await extendAttempts(actor, { assessmentId, ...input });
    return { extended: r.extended, skipped: r.skipped };
  });
  if (result.ok) revalidatePath("/learner", "layout");
  return done(assessmentId, result);
}

/** Unschedule a scheduled assessment (only before it starts) so it can be edited again. */
export async function moveAssessmentToDraftAction(id: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () => void (await transitionAssessment(actor, id, AssessmentStatus.DRAFT)));
  // Scheduled → draft takes the assessment away from its learners.
  if (result.ok) await notify(id, "CANCELLED", actor.id);
  return done(id, result);
}

/** Archive a draft (or a published assessment). The lifecycle decides whether it is allowed. */
export async function archiveAssessmentAction(id: string): Promise<ActionResult> {
  const actor = await requireRole(Role.ADMIN);
  return done(id, await runAction(async () => void (await transitionAssessment(actor, id, AssessmentStatus.ARCHIVED))));
}

/**
 * Learner passwords for the assessment's candidates: learners without one get one; with `reset`,
 * every candidate gets a new one (a learner's password is shared by all their assessments). The
 * plain passwords are returned once, for the admin to hand out; only their hashes are stored.
 */
export async function issueLearnerPasswordsAction(id: string, reset = false): Promise<ActionResult<{ name: string; email: string; password: string }[]>> {
  const actor = await requireRole(Role.ADMIN);
  const result = await runAction(async () =>
    (await issueLearnerPasswords(actor, id, { reset: reset === true })).map((c) => ({ name: c.learner.name, email: c.learner.email, password: c.password })),
  );
  if (result.ok) refresh(id);
  return result;
}
