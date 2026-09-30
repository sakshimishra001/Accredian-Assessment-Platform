import { z } from "zod";
import { AssessmentType, ResultVisibility } from "@/generated/prisma/enums";
import { checkbox, istDateTime, marksSchema, optionalText } from "./common";

export const MAX_DURATION_MINUTES = 600;
export const MAX_ATTEMPTS_LIMIT = 10;

/** Field-level rules. Cross-field rules live in `assessmentRuleIssues` so they also run after partial updates. */
export const assessmentFieldsSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(3, "Name must be at least 3 characters").max(200),
  description: optionalText(5000),
  courseId: z.string({ error: "Choose a course" }).min(1, "Choose a course"),
  type: z.enum(AssessmentType, { error: "Choose an assessment type" }),
  durationMinutes: z.coerce
    .number({ error: "Enter the duration in minutes" })
    .int("Duration must be whole minutes")
    .min(1, "Duration must be at least 1 minute")
    .max(MAX_DURATION_MINUTES, `Duration must be ${MAX_DURATION_MINUTES} minutes or less`),
  startAt: istDateTime,
  endAt: istDateTime,
  maxAttempts: z.coerce
    .number({ error: "Enter a number" })
    .int("Must be a whole number")
    .min(1, "At least 1 attempt")
    .max(MAX_ATTEMPTS_LIMIT, `At most ${MAX_ATTEMPTS_LIMIT} attempts`),
  passingMarks: marksSchema,
  resultVisibility: z.enum(ResultVisibility, { error: "Choose when results are visible" }),
  proctoringEnabled: checkbox,
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

export const createAssessmentSchema = assessmentFieldsSchema.superRefine((v, ctx) => {
  for (const i of assessmentRuleIssues(v)) ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
});

export const updateAssessmentSchema = assessmentFieldsSchema.partial();

export const RESULT_VISIBILITY_LABEL: Record<ResultVisibility, string> = {
  ON_PUBLISH: "When results are published",
  IMMEDIATE: "Immediately after submission",
};

export const ASSESSMENT_TYPE_LABEL: Record<AssessmentType, string> = {
  OBJECTIVE: "Objective",
  SUBJECTIVE: "Subjective",
  MIXED: "Mixed",
};
