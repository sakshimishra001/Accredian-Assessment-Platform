import { z } from "zod";
import { QuestionGroupType, SectionAttemptRule } from "@/generated/prisma/enums";
import { checkbox, optionalText } from "./common";
import { questionInputSchema } from "./question";

export const paperFieldsSchema = z.object({
  name: z.string({ error: "Paper name is required" }).trim().min(3, "Paper name must be at least 3 characters").max(200),
  description: optionalText(5000),
  instructions: optionalText(10000),
  courseId: z.string({ error: "Choose a course" }).min(1, "Choose a course"),
  subject: optionalText(100),
  durationMinutes: z.preprocess(
    (v) => (v === "" || v == null ? null : v),
    z.coerce.number().int("Whole minutes only").min(1, "At least 1 minute").max(600, "At most 600 minutes").nullable(),
  ),
});

export const createPaperSchema = paperFieldsSchema;
/** The course of a paper is fixed once created. */
export const updatePaperSchema = paperFieldsSchema.omit({ courseId: true }).partial();

const attemptCount = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.coerce.number({ error: "Enter a number" }).int("Must be a whole number").min(1, "Must be at least 1").max(500).nullable(),
);

/** Section configuration; N is required for every rule except ALL and forbidden for ALL. */
export const sectionSchema = z
  .object({
    title: z.string({ error: "Section title is required" }).trim().min(1, "Section title is required").max(200),
    instructions: optionalText(5000),
    isRequired: z.preprocess((v) => (v === undefined ? true : v), checkbox),
    attemptRule: z.enum(SectionAttemptRule, { error: "Choose an attempt rule" }).default(SectionAttemptRule.ALL),
    attemptCount,
  })
  .superRefine((s, ctx) => {
    if (s.attemptRule === SectionAttemptRule.ALL && s.attemptCount != null) {
      ctx.addIssue({ code: "custom", path: ["attemptCount"], message: "“Attempt all” doesn’t take a number" });
    }
    if (s.attemptRule !== SectionAttemptRule.ALL && s.attemptCount == null) {
      ctx.addIssue({ code: "custom", path: ["attemptCount"], message: "Enter how many questions (N)" });
    }
  });

export type SectionInput = z.input<typeof sectionSchema>;
export type SectionData = z.output<typeof sectionSchema>;

export const groupSchema = z.object({
  groupType: z.enum(QuestionGroupType, { error: "Choose case study or comprehension" }),
  text: z.string({ error: "Enter the case/passage title or prompt" }).trim().min(1, "Enter the case/passage title or prompt").max(5000),
  passage: optionalText(20000),
});

export type GroupData = z.output<typeof groupSchema>;



/** Structured import payload (from the parser, possibly corrected by the admin) to save into a paper. */
export const importItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), question: questionInputSchema }),
  z.object({
    kind: z.literal("group"),
    group: groupSchema,
    children: z.array(questionInputSchema).min(1, "A case/passage needs at least one sub-question"),
  }),
]);

export const importPayloadSchema = z.object({
  sourceFileName: optionalText(255),
  sections: z
    .array(sectionSchema.and(z.object({ items: z.array(importItemSchema).min(1, "A section needs at least one question") })))
    .min(1, "Nothing to import"),
});

export type ImportPayloadInput = z.input<typeof importPayloadSchema>;
export type ImportPayload = z.output<typeof importPayloadSchema>;
