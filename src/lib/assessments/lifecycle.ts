import { AssessmentStatus, AssessmentType } from "@/generated/prisma/enums";

export { AssessmentStatus };

export const STATUS_LABEL: Record<AssessmentStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  ACTIVE: "Active",
  PAUSED: "Paused",
  ENDED: "Ended",
  EVALUATION: "Evaluation",
  RESULT_READY: "Result ready",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

export const STATUS_ORDER: readonly AssessmentStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "ACTIVE",
  "PAUSED",
  "ENDED",
  "EVALUATION",
  "RESULT_READY",
  "PUBLISHED",
  "ARCHIVED",
];

export type TransitionTrigger = "manual" | "system";

export interface TransitionDef {
  from: AssessmentStatus;
  to: AssessmentStatus;
  /** manual = an admin clicks it; system = happens automatically when the clock passes start/end. */
  triggers: readonly TransitionTrigger[];
  label: string;
  description: string;
}

export const TRANSITIONS: readonly TransitionDef[] = [
  { from: "DRAFT", to: "SCHEDULED", triggers: ["manual"], label: "Publish", description: "Lock the paper, batch and settings and make the assessment available at its start time." },
  { from: "SCHEDULED", to: "DRAFT", triggers: ["manual"], label: "Back to draft", description: "Unschedule so questions and settings can be edited again." },
  { from: "SCHEDULED", to: "ACTIVE", triggers: ["system"], label: "Activate", description: "Starts automatically at the start time." },
  { from: "SCHEDULED", to: "ENDED", triggers: ["system"], label: "End", description: "The whole window passed." },
  { from: "ACTIVE", to: "ENDED", triggers: ["manual", "system"], label: "End now", description: "Close the assessment immediately. Learners can no longer start or submit." },
  { from: "ACTIVE", to: "PAUSED", triggers: ["manual"], label: "Pause assessment", description: "Stop all running attempts for now: no answering or submitting, and their timers stop." },
  { from: "PAUSED", to: "ACTIVE", triggers: ["manual"], label: "Resume assessment", description: "Learners continue where they were, with the time they had left." },
  { from: "PAUSED", to: "ENDED", triggers: ["system"], label: "End", description: "The window's end time passed while the assessment was paused." },
  { from: "ENDED", to: "EVALUATION", triggers: ["manual"], label: "Start evaluation", description: "Open subjective answers for examiner evaluation." },
  { from: "ENDED", to: "RESULT_READY", triggers: ["manual"], label: "Mark results ready", description: "Objective-only: scores are automatic, so results are ready." },
  { from: "EVALUATION", to: "RESULT_READY", triggers: ["manual"], label: "Complete evaluation", description: "All evaluation is finished; results can be reviewed before publishing." },
  { from: "RESULT_READY", to: "EVALUATION", triggers: ["manual"], label: "Reopen evaluation", description: "Send back to evaluation to correct marks." },
  { from: "RESULT_READY", to: "PUBLISHED", triggers: ["manual"], label: "Publish results", description: "Learners can see their results." },
  { from: "DRAFT", to: "ARCHIVED", triggers: ["manual"], label: "Archive", description: "Hide this draft from active lists. This cannot be undone." },
  { from: "PUBLISHED", to: "ARCHIVED", triggers: ["manual"], label: "Archive", description: "Move to the archive. Results remain available. This cannot be undone." },
];

export function findTransition(from: AssessmentStatus, to: AssessmentStatus) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Facts about an assessment needed to decide whether a transition is allowed. */
export interface TransitionContext {
  status: AssessmentStatus;
  type: AssessmentType;
  startAt: Date;
  endAt: Date;
  passingMarks: number;
  totalMarks: number;
  questionCount: number;
  objectiveCount: number;
  subjectiveCount: number;
  incompatibleCount: number;
  archivedQuestionCount: number;
  /** The selected question paper, or null when none is selected (no approval is involved). */
  paper: object | null;
  /** The selected batch, or null when none is selected. */
  batch: { active: boolean; learnerCount: number } | null;
  /** Attempts still being taken (block marking results ready). */
  openAttemptCount: number;
  /** Submitted attempts whose evaluation isn't finalized (block marking results ready). */
  pendingEvaluationCount: number;
}

export type TransitionCheck = { ok: true } | { ok: false; reasons: string[] };

/** Everything that must be true before an assessment can be published (DRAFT → SCHEDULED). */
export function scheduleReadiness(ctx: TransitionContext, now: Date): string[] {
  const reasons: string[] = [];
  if (!ctx.paper) reasons.push("Select a question paper.");
  if (!ctx.batch) reasons.push("Select the batch that will take this assessment.");
  else if (!ctx.batch.active) reasons.push("The selected batch is inactive.");
  else if (ctx.batch.learnerCount === 0) reasons.push("The selected batch has no active learners.");
  if (ctx.questionCount === 0) reasons.push("Add at least one question.");
  if (ctx.questionCount > 0 && ctx.totalMarks <= 0) reasons.push("Total marks must be greater than zero.");
  if (ctx.passingMarks > ctx.totalMarks) {
    reasons.push(`Passing marks (${ctx.passingMarks}) exceed total marks (${ctx.totalMarks}).`);
  }
  if (ctx.startAt.getTime() <= now.getTime()) reasons.push("Start time must be in the future.");
  if (ctx.incompatibleCount > 0) {
    reasons.push(`${ctx.incompatibleCount} question(s) do not match the ${ctx.type.toLowerCase()} assessment type.`);
  }
  if (ctx.archivedQuestionCount > 0) reasons.push(`${ctx.archivedQuestionCount} inactive question(s) must be removed.`);
  if (ctx.type === AssessmentType.MIXED && ctx.questionCount > 0 && (ctx.objectiveCount === 0 || ctx.subjectiveCount === 0)) {
    reasons.push("A mixed assessment needs at least one objective and one subjective question.");
  }
  return reasons;
}

export function checkTransition(
  ctx: TransitionContext,
  to: AssessmentStatus,
  { now = new Date(), trigger = "manual" }: { now?: Date; trigger?: TransitionTrigger } = {},
): TransitionCheck {
  const def = findTransition(ctx.status, to);
  if (!def || !def.triggers.includes(trigger)) {
    return {
      ok: false,
      reasons: [`Cannot move from ${STATUS_LABEL[ctx.status]} to ${STATUS_LABEL[to]}${trigger === "manual" ? " manually" : ""}.`],
    };
  }

  const reasons: string[] = [];
  switch (`${ctx.status}->${to}`) {
    case "DRAFT->SCHEDULED":
      reasons.push(...scheduleReadiness(ctx, now));
      break;
    case "SCHEDULED->DRAFT":
      if (now.getTime() >= ctx.startAt.getTime()) reasons.push("The start time has already passed.");
      break;
    case "SCHEDULED->ACTIVE":
      if (now.getTime() < ctx.startAt.getTime()) reasons.push("The start time has not been reached.");
      break;
    case "SCHEDULED->ENDED":
      if (now.getTime() < ctx.endAt.getTime()) reasons.push("The end time has not been reached.");
      break;
    case "ACTIVE->ENDED":
      if (trigger === "system" && now.getTime() < ctx.endAt.getTime()) reasons.push("The end time has not been reached.");
      break;
    case "ACTIVE->PAUSED":
    case "PAUSED->ACTIVE":
      reasons.push(...liveControlIssues(ctx, now));
      break;
    case "PAUSED->ENDED":
      if (now.getTime() < ctx.endAt.getTime()) reasons.push("The end time has not been reached.");
      break;
    case "ENDED->EVALUATION":
    case "RESULT_READY->EVALUATION":
      if (ctx.type === AssessmentType.OBJECTIVE) reasons.push("Objective assessments are scored automatically and need no evaluation.");
      break;
    case "ENDED->RESULT_READY":
      if (ctx.type !== AssessmentType.OBJECTIVE) reasons.push("Assessments with subjective questions must go through evaluation first.");
      reasons.push(...resultReadinessIssues(ctx));
      break;
    case "EVALUATION->RESULT_READY":
      reasons.push(...resultReadinessIssues(ctx));
      break;
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * Pause and resume only happen inside the assessment's window: once its end time has passed the
 * assessment ends by the clock instead (the window is never moved by a pause).
 */
export function liveControlIssues(ctx: Pick<TransitionContext, "endAt">, now: Date): string[] {
  return now.getTime() >= ctx.endAt.getTime() ? ["The assessment's end time has passed."] : [];
}

/** Results can only be ready when nobody is still writing and every evaluation is finalized. */
export function resultReadinessIssues(ctx: Pick<TransitionContext, "openAttemptCount" | "pendingEvaluationCount">): string[] {
  const reasons: string[] = [];
  if (ctx.openAttemptCount > 0) reasons.push(`${ctx.openAttemptCount} attempt(s) are still in progress.`);
  if (ctx.pendingEvaluationCount > 0) reasons.push(`${ctx.pendingEvaluationCount} attempt(s) still need evaluation.`);
  return reasons;
}

/** Manual transitions available from the current status, each with whether it is currently allowed. */
export function availableActions(ctx: TransitionContext, now = new Date()) {
  return TRANSITIONS.filter((t) => t.from === ctx.status && t.triggers.includes("manual")).map((t) => ({
    ...t,
    check: checkTransition(ctx, t.to, { now, trigger: "manual" }),
  }));
}

/**
 * Where the clock alone should move an assessment. SCHEDULED, ACTIVE and PAUSED are time-driven
 * (a paused assessment still ends at its end time); every other status only changes by admin action.
 */
export function timeBasedStatus(
  status: AssessmentStatus,
  startAt: Date,
  endAt: Date,
  now: Date,
): AssessmentStatus {
  const t = now.getTime();
  if (status === "SCHEDULED") {
    if (t >= endAt.getTime()) return "ENDED";
    if (t >= startAt.getTime()) return "ACTIVE";
  }
  if ((status === "ACTIVE" || status === "PAUSED") && t >= endAt.getTime()) return "ENDED";
  return status;
}

// ---------------------------------------------------------------------------
// Edit policy — what may change in each status
// ---------------------------------------------------------------------------

export const ASSESSMENT_FIELDS = [
  "name",
  "description",
  "instructions",
  "paperId",
  "batchId",
  "type",
  "durationMinutes",
  "startAt",
  "endAt",
  "maxAttempts",
  "passingMarks",
  "resultVisibility",
  "resultDetail",
  "proctoringEnabled",
  "timingMode",
  "randomizeQuestions",
  "randomizeOptions",
  "allowResume",
  "showQuestionPalette",
  "allowMarkForReview",
  "negativeMarking",
  "calculatorEnabled",
  "calculatorType",
  "spellCheckEnabled",
  "focusMonitoringEnabled",
  "focusMaxViolations",
  "focusViolationAction",
  "fullscreenEnabled",
  "clipboardMonitoringEnabled",
  "cameraRequired",
  "faceDetectionEnabled",
  "multipleFaceDetectionEnabled",
  "faceMissingDetectionEnabled",
  "cameraSnapshotsEnabled",
  "screenMonitoringEnabled",
] as const;

export type AssessmentField = (typeof ASSESSMENT_FIELDS)[number];

export const FIELD_LABEL: Record<AssessmentField, string> = {
  name: "Name",
  description: "Description",
  instructions: "Instructions",
  paperId: "Question paper",
  batchId: "Batch",
  type: "Assessment type",
  durationMinutes: "Duration",
  startAt: "Start time",
  endAt: "End time",
  maxAttempts: "Maximum attempts",
  passingMarks: "Passing marks",
  resultVisibility: "Result visibility",
  resultDetail: "Result detail",
  proctoringEnabled: "Proctoring",
  timingMode: "Start / end behaviour",
  randomizeQuestions: "Randomize questions",
  randomizeOptions: "Randomize options",
  allowResume: "Allow resume",
  showQuestionPalette: "Question palette",
  allowMarkForReview: "Mark for review",
  negativeMarking: "Negative marking",
  calculatorEnabled: "Calculator",
  calculatorType: "Calculator type",
  spellCheckEnabled: "Spell check",
  focusMonitoringEnabled: "Focus monitoring",
  focusMaxViolations: "Maximum focus violations",
  focusViolationAction: "Action at the violation limit",
  fullscreenEnabled: "Fullscreen enforcement",
  clipboardMonitoringEnabled: "Clipboard monitoring",
  cameraRequired: "Require camera",
  faceDetectionEnabled: "Face detection",
  multipleFaceDetectionEnabled: "Multiple face detection",
  faceMissingDetectionEnabled: "Face missing detection",
  cameraSnapshotsEnabled: "Camera snapshots",
  screenMonitoringEnabled: "Screen monitoring",
};

/**
 * DRAFT: everything. SCHEDULED: cosmetic fields, the window and learner tools (paper, batch,
 * questions and rules are frozen). ACTIVE: only extending the end time — learners mid-exam never
 * gain or lose a tool. PAUSED and later statuses: read-only.
 */
const EDITABLE: Record<AssessmentStatus, readonly AssessmentField[]> = {
  DRAFT: ASSESSMENT_FIELDS,
  SCHEDULED: ["name", "description", "instructions", "startAt", "endAt", "calculatorEnabled", "calculatorType", "spellCheckEnabled", "proctoringEnabled", "focusMonitoringEnabled", "focusMaxViolations", "focusViolationAction", "fullscreenEnabled", "clipboardMonitoringEnabled", "cameraRequired", "faceDetectionEnabled", "multipleFaceDetectionEnabled", "faceMissingDetectionEnabled", "cameraSnapshotsEnabled", "screenMonitoringEnabled"],
  ACTIVE: ["endAt"],
  PAUSED: [],
  ENDED: [],
  EVALUATION: [],
  RESULT_READY: [],
  PUBLISHED: [],
  ARCHIVED: [],
};

export function editableFields(status: AssessmentStatus): readonly AssessmentField[] {
  return EDITABLE[status];
}

export function isFieldEditable(status: AssessmentStatus, field: AssessmentField): boolean {
  return EDITABLE[status].includes(field);
}

export function canEditSettings(status: AssessmentStatus): boolean {
  return EDITABLE[status].length > 0;
}

/** Questions (membership, order, marks) can only change while the assessment is a draft. */
export function canEditQuestions(status: AssessmentStatus): boolean {
  return status === "DRAFT";
}
