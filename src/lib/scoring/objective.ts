import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { hasOptions } from "@/lib/questions/types";

/**
 * Objective scoring rules (applied to the frozen assessment snapshot, never the live bank question):
 *
 * - Unanswered (no option selected) → 0.
 * - Correct → full marks.
 * - Wrong → −negativeMarks.
 * - MCQ_MULTI is all-or-nothing: the selected set must equal the correct set exactly.
 *   Any other non-empty selection counts as wrong.
 * - Selections referring to options that are not in the snapshot are ignored.
 * - The assessment total is floored at 0 (see `totalObjectiveScore`); individual questions may be negative.
 *
 * All arithmetic is done in hundredths so 0.25-step marks never drift.
 */

export type ObjectiveOutcome = "correct" | "incorrect" | "unanswered";

export interface ObjectiveScore {
  outcome: ObjectiveOutcome;
  score: number;
  maxScore: number;
}

export interface ScorableQuestion {
  snapshot: QuestionSnapshot;
  marks: number;
  negativeMarks: number;
}

const cents = (n: number) => Math.round(n * 100);

export function isObjective(snapshot: Pick<QuestionSnapshot, "type">): boolean {
  return hasOptions(snapshot.type);
}

/** IDs of the correct options, in display order. */
export function answerKey(snapshot: QuestionSnapshot): string[] {
  return [...snapshot.options].sort((a, b) => a.position - b.position).filter((o) => o.isCorrect).map((o) => o.id);
}

/**
 * Structural problems that would make a snapshot unscorable. An empty list means it is safe to score.
 * Question validation prevents these at authoring time; this guards data coming back from storage.
 */
export function answerKeyProblems(snapshot: QuestionSnapshot): string[] {
  if (!isObjective(snapshot)) {
    return snapshot.options.length ? ["Subjective questions must not have options"] : [];
  }
  const problems: string[] = [];
  const ids = snapshot.options.map((o) => o.id);
  const correct = snapshot.options.filter((o) => o.isCorrect).length;
  if (new Set(ids).size !== ids.length) problems.push("Option ids must be unique");
  if (snapshot.type === "TRUE_FALSE" && snapshot.options.length !== 2) problems.push("True/False needs exactly 2 options");
  if (snapshot.type !== "TRUE_FALSE" && snapshot.options.length < 2) problems.push("MCQs need at least 2 options");
  if ((snapshot.type === "MCQ_SINGLE" || snapshot.type === "TRUE_FALSE") && correct !== 1) {
    problems.push("Exactly one option must be correct");
  }
  if (snapshot.type === "MCQ_MULTI" && correct < 1) problems.push("At least one option must be correct");
  return problems;
}

export function scoreObjectiveAnswer(question: ScorableQuestion, selectedOptionIds: readonly string[]): ObjectiveScore {
  const { snapshot, marks, negativeMarks } = question;
  if (!isObjective(snapshot)) throw new Error(`Question type ${snapshot.type} is not objectively scorable`);
  const problems = answerKeyProblems(snapshot);
  if (problems.length) throw new Error(`Invalid answer key for question ${snapshot.questionId}: ${problems.join("; ")}`);

  const valid = new Set(snapshot.options.map((o) => o.id));
  const selected = new Set(selectedOptionIds.filter((id) => valid.has(id)));
  if (selected.size === 0) return { outcome: "unanswered", score: 0, maxScore: marks };

  const key = new Set(answerKey(snapshot));
  const correct =
    snapshot.type === "MCQ_MULTI"
      ? selected.size === key.size && [...selected].every((id) => key.has(id))
      : selected.size === 1 && key.has([...selected][0]);

  if (correct) return { outcome: "correct", score: marks, maxScore: marks };
  return { outcome: "incorrect", score: negativeMarks > 0 ? -negativeMarks : 0, maxScore: marks };
}

/** Sum of per-question scores, floored at 0. */
export function totalObjectiveScore(scores: readonly Pick<ObjectiveScore, "score">[]): number {
  const total = scores.reduce((acc, s) => acc + cents(s.score), 0);
  return Math.max(0, total) / 100;
}

/** Maximum achievable marks for a set of assessment questions. */
export function maxTotal(questions: readonly { marks: number }[]): number {
  return questions.reduce((acc, q) => acc + cents(q.marks), 0) / 100;
}
