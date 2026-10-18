import { SectionAttemptRule } from "@/generated/prisma/enums";
import { round2, sectionMaxMarks } from "@/lib/papers/rules";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { isObjective, scoreObjectiveAnswer, totalObjectiveScore } from "./objective";

/**
 * The one place an attempt's result is calculated.
 *
 * - Objective questions: the existing `scoreObjectiveAnswer` on the frozen snapshot (negative
 *   marks only when the assessment applies negative marking).
 * - Subjective questions: examiner-awarded marks; an unanswered one scores 0 and needs no examiner;
 *   an answered one without marks yet is "pending".
 * - Sections: a case/passage counts as one item (sum of its parts). ALL counts every item;
 *   ANY_N / EXACTLY_N / UP_TO_N / BEST_N count the N best-scoring items — the same rule used for
 *   the paper's maximum marks (`sectionMaxMarks`).
 * - The total is floored at 0, as `totalObjectiveScore` does.
 */

export type QuestionOutcome = "correct" | "incorrect" | "unanswered" | "pending" | "evaluated";

export interface ResultQuestionInput {
  assessmentQuestionId: string;
  snapshot: QuestionSnapshot;
  marks: number;
  /** Already 0 when the assessment doesn't apply negative marking. */
  negativeMarks: number;
  section: { id: string; attemptRule: SectionAttemptRule; attemptCount: number | null } | null;
  /** Questions sharing a key form one item (sub-questions of a case use the case's id). */
  itemKey: string;
  /** `hasFiles`: the learner uploaded at least one file as (part of) the answer. */
  response: { selectedOptionIds: string[]; textAnswer: string | null; awardedMarks: number | null; hasFiles?: boolean } | null;
}

export interface QuestionResult {
  assessmentQuestionId: string;
  kind: "objective" | "subjective";
  outcome: QuestionOutcome;
  maxMarks: number;
  /** null while an examiner still has to mark it. */
  awarded: number | null;
}

export interface AttemptResult {
  /** True when nothing is pending: `obtained` is then the final mark. */
  complete: boolean;
  maxMarks: number;
  /** Final marks (section rules applied, floored at 0); null while evaluation is pending. */
  obtained: number | null;
  /** The same calculation treating pending answers as 0, for evaluators and admins. */
  provisional: number;
  percentage: number | null;
  /** Per-question sums before section rules (they add up to the total when every section is ALL). */
  objectiveMarks: number;
  subjectiveMarks: number;
  /** Marks deducted for wrong objective answers (a positive number). */
  negativeMarks: number;
  counts: { questions: number; answered: number; unanswered: number; correct: number; incorrect: number; pending: number; evaluated: number };
  questions: QuestionResult[];
}

const cents = (n: number) => Math.round(n * 100);
const sum = (xs: number[]) => xs.reduce((a, b) => a + cents(b), 0) / 100;

export function scoreQuestion(q: ResultQuestionInput): QuestionResult {
  if (isObjective(q.snapshot)) {
    const s = scoreObjectiveAnswer({ snapshot: q.snapshot, marks: q.marks, negativeMarks: q.negativeMarks }, q.response?.selectedOptionIds ?? []);
    return { assessmentQuestionId: q.assessmentQuestionId, kind: "objective", outcome: s.outcome, maxMarks: q.marks, awarded: s.score };
  }
  const answered = !!q.response?.textAnswer?.trim() || !!q.response?.hasFiles;
  if (!answered) return { assessmentQuestionId: q.assessmentQuestionId, kind: "subjective", outcome: "unanswered", maxMarks: q.marks, awarded: 0 };
  const awarded = q.response?.awardedMarks ?? null;
  return { assessmentQuestionId: q.assessmentQuestionId, kind: "subjective", outcome: awarded === null ? "pending" : "evaluated", maxMarks: q.marks, awarded };
}

export function calculateAttemptResult(inputs: ResultQuestionInput[]): AttemptResult {
  const questions = inputs.map(scoreQuestion);

  type Section = { rule: SectionAttemptRule; count: number | null; items: Map<string, { max: number; score: number }> };
  const sections = new Map<string, Section>();
  inputs.forEach((q, i) => {
    const key = q.section?.id ?? "__all__";
    const s = sections.get(key) ?? { rule: q.section?.attemptRule ?? SectionAttemptRule.ALL, count: q.section?.attemptCount ?? null, items: new Map() };
    const item = s.items.get(q.itemKey) ?? { max: 0, score: 0 };
    item.max = round2(item.max + q.marks);
    item.score = round2(item.score + (questions[i].awarded ?? 0));
    s.items.set(q.itemKey, item);
    sections.set(key, s);
  });

  let maxMarks = 0;
  const sectionScores: number[] = [];
  for (const s of sections.values()) {
    const items = [...s.items.values()];
    maxMarks = round2(maxMarks + sectionMaxMarks(s.rule, s.count, items.map((i) => i.max)));
    const scores = items.map((i) => i.score).sort((a, b) => b - a);
    sectionScores.push(sum(s.rule === SectionAttemptRule.ALL || s.count == null ? scores : scores.slice(0, s.count)));
  }
  const provisional = totalObjectiveScore(sectionScores.map((score) => ({ score })));

  const by = (o: QuestionOutcome) => questions.filter((q) => q.outcome === o).length;
  const pending = by("pending");
  const complete = pending === 0;
  const obtained = complete ? provisional : null;
  const objective = questions.filter((q) => q.kind === "objective");
  return {
    complete,
    maxMarks,
    obtained,
    provisional,
    percentage: obtained === null ? null : maxMarks > 0 ? round2((obtained / maxMarks) * 100) : 0,
    objectiveMarks: sum(objective.map((q) => q.awarded ?? 0)),
    subjectiveMarks: sum(questions.filter((q) => q.kind === "subjective").map((q) => q.awarded ?? 0)),
    negativeMarks: -sum(objective.map((q) => Math.min(0, q.awarded ?? 0))) || 0,
    counts: {
      questions: questions.length,
      answered: questions.length - by("unanswered"),
      unanswered: by("unanswered"),
      correct: by("correct"),
      incorrect: by("incorrect"),
      pending,
      evaluated: by("evaluated"),
    },
    questions,
  };
}
