import type { AttemptRuleKind, Question, QuestionPaper, QuestionType, Section } from "../types";

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  MCQ_SINGLE: "MCQ — Single",
  MCQ_MULTI: "MCQ — Multiple",
  TRUE_FALSE: "True / False",
  SHORT_ANSWER: "Short Answer",
  LONG_ANSWER: "Long Answer",
  COMPREHENSION: "Comprehension",
  CASE_STUDY: "Case Study",
};

export const QUESTION_TYPES = Object.keys(QUESTION_TYPE_LABEL) as QuestionType[];

export const ATTEMPT_RULE_LABEL: Record<AttemptRuleKind, string> = {
  COMPULSORY: "Compulsory",
  OPTIONAL: "Optional",
  ANY_N: "Attempt any N",
  EXACTLY_N: "Exactly N",
  BEST_N: "Best N",
  UP_TO_N: "Up to N",
};

export const RULES_WITH_COUNT: AttemptRuleKind[] = ["ANY_N", "EXACTLY_N", "BEST_N", "UP_TO_N"];

export function isObjectiveType(t: QuestionType) {
  return t === "MCQ_SINGLE" || t === "MCQ_MULTI" || t === "TRUE_FALSE" || t === "COMPREHENSION";
}

export function hasOptions(t: QuestionType) {
  return t === "MCQ_SINGLE" || t === "MCQ_MULTI" || t === "TRUE_FALSE";
}

export function isGroupType(t: QuestionType) {
  return t === "COMPREHENSION" || t === "CASE_STUDY";
}

export function sectionQuestions(paper: Pick<QuestionPaper, "questions">, sectionId: string) {
  return paper.questions.filter((q) => q.sectionId === sectionId);
}

/** Human-readable attempt rule, e.g. "Attempt any 5 of 8", "Best 5 of 7 count". */
export function ruleText(section: Section, questionCount: number) {
  const n = section.ruleCount ?? 0;
  switch (section.rule) {
    case "COMPULSORY":
      return `All ${questionCount} compulsory`;
    case "OPTIONAL":
      return "Optional";
    case "ANY_N":
      return `Attempt any ${n} of ${questionCount}`;
    case "EXACTLY_N":
      return `Attempt exactly ${n} of ${questionCount}`;
    case "BEST_N":
      return `Best ${n} of ${questionCount} count`;
    case "UP_TO_N":
      return `Attempt up to ${n} of ${questionCount}`;
  }
}

/** Short explanation for the rule picker. */
export const RULE_HELP: Record<AttemptRuleKind, string> = {
  COMPULSORY: "Learners must answer every question in the section.",
  OPTIONAL: "Learners may skip the whole section; answered questions still score.",
  ANY_N: "Learners choose N questions to answer. Only those are marked.",
  EXACTLY_N: "Learners must answer exactly N questions — no more, no fewer.",
  BEST_N: "Learners may answer all; the N highest-scoring answers count.",
  UP_TO_N: "Learners may answer at most N questions.",
};

export function paperTotals(paper: Pick<QuestionPaper, "questions" | "sections">) {
  const top = paper.questions;
  const objective = top.filter((q) => isObjectiveType(q.type)).length;
  const needsReview = countWhere(top, (q) => q.needsReview);
  return {
    questions: top.length,
    objective,
    subjective: top.length - objective,
    sections: paper.sections.length,
    marks: paper.sections.reduce((s, x) => s + x.marks, 0),
    needsReview,
  };
}

export function countWhere(qs: Question[], pred: (q: Question) => boolean): number {
  return qs.reduce((n, q) => n + (pred(q) ? 1 : 0) + countWhere(q.children, pred), 0);
}

/** Flat list of every question including nested ones, in display order. */
export function flatten(qs: Question[]): Question[] {
  return qs.flatMap((q) => [q, ...flatten(q.children)]);
}

export function mapQuestions(qs: Question[], fn: (q: Question) => Question): Question[] {
  return qs.map((q) => fn({ ...q, children: mapQuestions(q.children, fn) }));
}

export function findQuestion(qs: Question[], id: string): Question | undefined {
  for (const q of qs) {
    if (q.id === id) return q;
    const child = findQuestion(q.children, id);
    if (child) return child;
  }
  return undefined;
}

/** Structural problems for a single question, shown in the review screen. */
export function questionIssues(q: Question): string[] {
  const issues: string[] = [];
  if (!q.text.trim()) issues.push("Question text is empty");
  if (q.marks <= 0 && !isGroupType(q.type)) issues.push("Marks not set");
  if (hasOptions(q.type)) {
    if (q.options.length < 2) issues.push("At least 2 options required");
    const correct = q.options.filter((o) => o.correct).length;
    if (correct === 0) issues.push("Correct answer not set");
    if ((q.type === "MCQ_SINGLE" || q.type === "TRUE_FALSE") && correct > 1) issues.push("Only one correct answer allowed");
    if (q.options.some((o) => !o.text.trim())) issues.push("An option is empty");
  }
  if (isGroupType(q.type) && q.children.length === 0) issues.push("Add at least one sub-question");
  if (q.response && q.response.type !== "text" && q.response.allowedTypes.length === 0) issues.push("Choose at least one allowed file type for the learner response");
  return issues;
}
