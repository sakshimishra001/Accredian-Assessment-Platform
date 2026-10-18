import { z } from "zod";

export const MAX_TEXT_ANSWER = 20_000;
export const MAX_RESPONSES_PER_SAVE = 500;

/** One answer as sent by the exam screen. Type-specific checks happen against the question snapshot. */
export const responseInputSchema = z.object({
  assessmentQuestionId: z.string({ error: "Question is required" }).min(1, "Question is required"),
  selectedOptionIds: z.array(z.string().min(1)).max(20, "Too many options selected").default([]),
  textAnswer: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : (v ?? null)),
    z.string().max(MAX_TEXT_ANSWER, `Answers can be at most ${MAX_TEXT_ANSWER.toLocaleString("en-IN")} characters`).nullable(),
  ),
  markedForReview: z.boolean().default(false),
  /**
   * Optional, increasing per question on the client. A save with a sequence not higher than the
   * stored one is ignored, so a delayed (out-of-order) autosave can't overwrite a newer answer.
   */
  clientSeq: z.number().int().min(0).optional(),
});

export type ResponseInput = z.output<typeof responseInputSchema>;

const responsesArray = z
  .array(responseInputSchema)
  .max(MAX_RESPONSES_PER_SAVE)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((r, i) => {
      if (seen.has(r.assessmentQuestionId)) ctx.addIssue({ code: "custom", path: [i, "assessmentQuestionId"], message: "The same question appears twice" });
      seen.add(r.assessmentQuestionId);
    });
  });

export const saveResponsesSchema = z.object({ responses: responsesArray.min(1, "Nothing to save") });
/** Submitting may include last unsaved answers (or none). */
export const submitAttemptSchema = z.object({ responses: responsesArray.default([]) });
