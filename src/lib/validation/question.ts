import { z } from "zod";
import { Difficulty, QuestionType } from "@/generated/prisma/enums";
import { hasOptions, TRUE_FALSE_LABELS } from "@/lib/questions/types";
import { marksSchema, optionalText } from "./common";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

const optionSchema = z.object({
  text: z.string().trim().max(1000, "Option must be 1000 characters or fewer"),
  isCorrect: z.boolean(),
});

/** Options arrive from the form as a JSON string; services may pass arrays directly. */
const optionsField = z.preprocess((v) => {
  if (typeof v !== "string") return v ?? [];
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.array(optionSchema, { error: "Options are invalid" }));

export const questionInputSchema = z
  .object({
    type: z.enum(QuestionType, { error: "Choose a question type" }),
    text: z.string({ error: "Question text is required" }).trim().min(1, "Question text is required").max(5000),
    guidance: optionalText(5000),
    marks: marksSchema,
    negativeMarks: z.preprocess((v) => (v === "" || v == null ? 0 : v), marksSchema),
    topic: optionalText(100),
    difficulty: z.enum(Difficulty, { error: "Choose a difficulty" }),
    courseId: optionalText(50),
    options: optionsField,
  })
  .superRefine((q, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });

    if (!hasOptions(q.type)) {
      if (q.negativeMarks > 0) issue("negativeMarks", "Subjective questions cannot have negative marks");
      return;
    }

    if (q.negativeMarks > q.marks) issue("negativeMarks", "Negative marks cannot exceed the question's marks");

    const correct = q.options.filter((o) => o.isCorrect).length;

    if (q.type === QuestionType.TRUE_FALSE) {
      if (q.options.length !== 2 || correct !== 1) issue("options", "Choose whether the statement is True or False");
      return;
    }

    if (q.options.length < MIN_OPTIONS) issue("options", `Add at least ${MIN_OPTIONS} options`);
    if (q.options.length > MAX_OPTIONS) issue("options", `Use at most ${MAX_OPTIONS} options`);
    if (q.options.some((o) => o.text.length === 0)) issue("options", "Options cannot be empty");
    const texts = q.options.map((o) => o.text.toLowerCase());
    if (new Set(texts).size !== texts.length) issue("options", "Options must be unique");

    if (q.type === QuestionType.MCQ_SINGLE && correct !== 1) issue("options", "Mark exactly one option as correct");
    if (q.type === QuestionType.MCQ_MULTI && correct < 1) issue("options", "Mark at least one option as correct");
  })
  .transform((q) => {
    if (!hasOptions(q.type)) return { ...q, negativeMarks: 0, options: [] };
    if (q.type === QuestionType.TRUE_FALSE) {
      // Fixed labels in a fixed order: [True, False].
      const trueIsCorrect = q.options[0].isCorrect;
      return {
        ...q,
        options: [
          { text: TRUE_FALSE_LABELS[0], isCorrect: trueIsCorrect },
          { text: TRUE_FALSE_LABELS[1], isCorrect: !trueIsCorrect },
        ],
      };
    }
    return q;
  });

export type QuestionInput = z.input<typeof questionInputSchema>;
export type QuestionData = z.output<typeof questionInputSchema>;
