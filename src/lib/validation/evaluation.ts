import { z } from "zod";
import { marksSchema, optionalText } from "./common";

/**
 * Marks an examiner awards to written answers. `marksSchema` already enforces a valid, non-negative
 * number with at most 2 decimals; the per-question maximum is checked by the service.
 */
export const evaluationMarksSchema = z.object({
  marks: z
    .array(
      z.object({
        assessmentQuestionId: z.string({ error: "Question is required" }).min(1, "Question is required"),
        awardedMarks: marksSchema,
        comment: optionalText(5000),
      }),
    )
    .min(1, "Enter marks for at least one answer")
    .max(500)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((m, i) => {
        if (seen.has(m.assessmentQuestionId)) ctx.addIssue({ code: "custom", path: [i, "assessmentQuestionId"], message: "The same question appears twice" });
        seen.add(m.assessmentQuestionId);
      });
    }),
});

export const reopenEvaluationSchema = z.object({
  reason: z.string({ error: "Give a reason" }).trim().min(5, "Give a reason (at least 5 characters)").max(2000),
});
