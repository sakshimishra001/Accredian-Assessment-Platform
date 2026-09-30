import { AssessmentType, QuestionType } from "@/generated/prisma/enums";

export { QuestionType };

export type QuestionKind = "OBJECTIVE" | "SUBJECTIVE";

export const QUESTION_TYPES: Record<QuestionType, { label: string; kind: QuestionKind }> = {
  MCQ_SINGLE: { label: "MCQ — single answer", kind: "OBJECTIVE" },
  MCQ_MULTI: { label: "MCQ — multiple answers", kind: "OBJECTIVE" },
  TRUE_FALSE: { label: "True / False", kind: "OBJECTIVE" },
  SHORT_ANSWER: { label: "Short answer", kind: "SUBJECTIVE" },
  LONG_ANSWER: { label: "Long answer", kind: "SUBJECTIVE" },
};

export const ALL_QUESTION_TYPES = Object.keys(QUESTION_TYPES) as QuestionType[];

export function questionKind(type: QuestionType): QuestionKind {
  return QUESTION_TYPES[type].kind;
}

export function hasOptions(type: QuestionType): boolean {
  return questionKind(type) === "OBJECTIVE";
}

/** Whether a question of `questionType` may be placed in an assessment of `assessmentType`. */
export function isQuestionCompatible(assessmentType: AssessmentType, questionType: QuestionType): boolean {
  if (assessmentType === AssessmentType.MIXED) return true;
  return questionKind(questionType) === assessmentType;
}

export const TRUE_FALSE_LABELS = ["True", "False"] as const;
