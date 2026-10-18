import { z } from "zod";
import { AssessmentTimingMode, AssessmentType, CalculatorType, FocusViolationAction, ResultDetail, ResultVisibility } from "@/generated/prisma/enums";
import { checkbox, istDateTime, marksSchema, optionalText } from "./common";

export const MAX_DURATION_MINUTES = 600;
export const MAX_ATTEMPTS_LIMIT = 10;
export const DEFAULT_ATTEMPTS = 1;
export const MAX_FOCUS_VIOLATIONS = 20;

/** Optional id reference: "" / null → null. */
const optionalId = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().min(1).nullable());
/** Checkbox whose default (when the field is absent) is on. */
const checkboxDefaultOn = z.preprocess((v) => (v === undefined ? true : v), checkbox);

/** Field-level rules. Cross-field rules live in `assessmentRuleIssues` so they also run after partial updates. */
export const assessmentFieldsSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(3, "Name must be at least 3 characters").max(200),
  description: optionalText(5000),
  instructions: optionalText(10000),
  /** Must be a complete question paper (checked by the service). */
  paperId: optionalId,
  /**
   * Must be an active batch (checked by the service): its learners are the candidates. Required to
   * create an assessment; the assessment's course is taken from it (no course is chosen).
   */
  batchId: optionalId,
  type: z.enum(AssessmentType, { error: "Choose an assessment type" }),
  durationMinutes: z.coerce
    .number({ error: "Enter the duration in minutes" })
    .int("Duration must be whole minutes")
    .min(1, "Duration must be at least 1 minute")
    .max(MAX_DURATION_MINUTES, `Duration must be ${MAX_DURATION_MINUTES} minutes or less`),
  startAt: istDateTime,
  endAt: istDateTime,
  maxAttempts: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? DEFAULT_ATTEMPTS : v),
    z.coerce.number({ error: "Enter a number" })
    .int("Must be a whole number")
    .min(1, "At least 1 attempt")
    .max(MAX_ATTEMPTS_LIMIT, `At most ${MAX_ATTEMPTS_LIMIT} attempts`),
  ),
  passingMarks: marksSchema,
  resultVisibility: z.enum(ResultVisibility, { error: "Choose when results are visible" }).default(ResultVisibility.ON_PUBLISH),
  resultDetail: z.enum(ResultDetail, { error: "Choose what learners see in their result" }).default(ResultDetail.SCORE),
  proctoringEnabled: checkbox,
  timingMode: z.enum(AssessmentTimingMode, { error: "Choose the start / end behaviour" }).default(AssessmentTimingMode.WINDOW),
  randomizeQuestions: checkbox,
  randomizeOptions: checkbox,
  allowResume: checkboxDefaultOn,
  showQuestionPalette: checkboxDefaultOn,
  allowMarkForReview: checkboxDefaultOn,
  negativeMarking: checkboxDefaultOn,
  /** Learner tool: an on-screen calculator during the exam (off by default). */
  calculatorEnabled: checkbox,
  calculatorType: z.enum(CalculatorType, { error: "Choose the calculator type" }).default(CalculatorType.BASIC),
  /** Learner tool: the browser's native spell check in written answers (off by default; never auto-correct). */
  spellCheckEnabled: checkbox,
  /** Focus monitoring (browser-based; off by default): the limit and what happens when it's reached. */
  focusMonitoringEnabled: checkbox,
  focusMaxViolations: z.coerce
    .number({ error: "Enter the maximum number of violations" })
    .int("Whole number only")
    .min(1, "At least 1")
    .max(MAX_FOCUS_VIOLATIONS, `At most ${MAX_FOCUS_VIOLATIONS}`)
    .default(3),
  focusViolationAction: z.enum(FocusViolationAction, { error: "Choose what happens at the limit" }).default(FocusViolationAction.TERMINATE),
  /**
   * Proctoring controls (all off by default; proctoringEnabled is the master switch). Camera
   * detections are saved as chosen but only apply while cameraRequired is on — they never turn the
   * camera on by themselves (see lib/proctoring/config.ts).
   */
  fullscreenEnabled: checkbox,
  clipboardMonitoringEnabled: checkbox,
  cameraRequired: checkbox,
  faceDetectionEnabled: checkbox,
  multipleFaceDetectionEnabled: checkbox,
  faceMissingDetectionEnabled: checkbox,
});

export type AssessmentValues = z.output<typeof assessmentFieldsSchema>;
export type AssessmentInput = z.input<typeof assessmentFieldsSchema>;

export interface RuleIssue {
  path: keyof AssessmentValues;
  message: string;
}

export function assessmentRuleIssues(v: AssessmentValues): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const windowMs = v.endAt.getTime() - v.startAt.getTime();
  if (windowMs <= 0) {
    issues.push({ path: "endAt", message: "End time must be after the start time" });
  } else if (windowMs < v.durationMinutes * 60_000) {
    issues.push({ path: "endAt", message: "The window between start and end must be at least as long as the duration" });
  }
  if (v.resultVisibility === ResultVisibility.IMMEDIATE && v.type !== AssessmentType.OBJECTIVE) {
    issues.push({ path: "resultVisibility", message: "Immediate results are only possible for objective assessments" });
  }
  return issues;
}

/**
 * Create. No course is chosen: the assessment takes its course from its batch. `courseId` is accepted
 * only for compatibility with programmatic callers that create a draft before choosing a batch; the
 * builder never sends it, and it can't be edited afterwards (a new batch brings its course).
 */
export const createAssessmentSchema = assessmentFieldsSchema.extend({ courseId: optionalId }).superRefine((v, ctx) => {
  if (!v.batchId && !v.courseId) ctx.addIssue({ code: "custom", path: ["batchId"], message: "Choose the batch that will take this assessment" });
  for (const i of assessmentRuleIssues(v)) ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
});

/**
 * Partial update: omitted fields stay undefined (unchanged). The create-time defaults are removed
 * first, because a defaulted field inside `.partial()` would otherwise be filled in and reset.
 */
export const updateAssessmentSchema = assessmentFieldsSchema
  .extend({
    resultVisibility: assessmentFieldsSchema.shape.resultVisibility.removeDefault(),
    resultDetail: assessmentFieldsSchema.shape.resultDetail.removeDefault(),
    timingMode: assessmentFieldsSchema.shape.timingMode.removeDefault(),
    calculatorType: assessmentFieldsSchema.shape.calculatorType.removeDefault(),
    focusMaxViolations: assessmentFieldsSchema.shape.focusMaxViolations.removeDefault(),
    focusViolationAction: assessmentFieldsSchema.shape.focusViolationAction.removeDefault(),
  })
  .partial();

export const RESULT_VISIBILITY_LABEL: Record<ResultVisibility, string> = {
  ON_PUBLISH: "When results are published",
  IMMEDIATE: "Immediately after submission",
};

export const ASSESSMENT_TYPE_LABEL: Record<AssessmentType, string> = {
  OBJECTIVE: "Objective",
  SUBJECTIVE: "Subjective",
  MIXED: "Mixed",
};
