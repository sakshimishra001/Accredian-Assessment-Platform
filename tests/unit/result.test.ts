import { describe, expect, it } from "vitest";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";
import { calculateAttemptResult, type ResultQuestionInput } from "@/lib/scoring/result";

let seq = 0;
function snap(type: QuestionSnapshot["type"], correct: boolean[] = []): QuestionSnapshot {
  const id = `q${++seq}`;
  return {
    questionId: id,
    version: 1,
    type,
    text: id,
    guidance: null,
    topic: null,
    difficulty: "MEDIUM",
    options: correct.map((isCorrect, i) => ({ id: `${id}-o${i + 1}`, text: `Option ${i + 1}`, isCorrect, position: i })),
  };
}

function q(
  snapshot: QuestionSnapshot,
  marks: number,
  answer: Partial<{ selected: string[]; text: string; awarded: number }> | null,
  extra: Partial<Pick<ResultQuestionInput, "negativeMarks" | "section" | "itemKey">> = {},
): ResultQuestionInput {
  return {
    assessmentQuestionId: `aq-${snapshot.questionId}`,
    snapshot,
    marks,
    negativeMarks: extra.negativeMarks ?? 0,
    section: extra.section ?? null,
    itemKey: extra.itemKey ?? snapshot.questionId,
    response: answer ? { selectedOptionIds: answer.selected ?? [], textAnswer: answer.text ?? null, awardedMarks: answer.awarded ?? null } : null,
  };
}

describe("objective scoring through the result calculator", () => {
  it("scores correct, incorrect, unanswered and negative marks across types", () => {
    const single = snap("MCQ_SINGLE", [false, true, false]);
    const multi = snap("MCQ_MULTI", [true, false, true]);
    const tf = snap("TRUE_FALSE", [true, false]);
    const wrong = snap("MCQ_SINGLE", [true, false]);
    const skipped = snap("MCQ_SINGLE", [true, false]);

    const r = calculateAttemptResult([
      q(single, 2, { selected: [single.options[1].id] }),
      q(multi, 3, { selected: [multi.options[2].id, multi.options[0].id] }),
      q(tf, 1, { selected: [tf.options[0].id] }),
      q(wrong, 2, { selected: [wrong.options[1].id] }, { negativeMarks: 0.5 }),
      q(skipped, 2, null, { negativeMarks: 0.5 }),
    ]);

    expect(r.questions.map((x) => [x.outcome, x.awarded])).toEqual([
      ["correct", 2],
      ["correct", 3],
      ["correct", 1],
      ["incorrect", -0.5],
      ["unanswered", 0],
    ]);
    expect(r).toMatchObject({ complete: true, maxMarks: 10, obtained: 5.5, percentage: 55, objectiveMarks: 5.5, subjectiveMarks: 0, negativeMarks: 0.5 });
    expect(r.counts).toMatchObject({ questions: 5, answered: 4, unanswered: 1, correct: 3, incorrect: 1 });
  });

  it("gives 0 for a wrong answer when negative marking is off, and partial multi-select is wrong", () => {
    const multi = snap("MCQ_MULTI", [true, true, false]);
    const r = calculateAttemptResult([q(multi, 4, { selected: [multi.options[0].id] })]);
    expect(r.questions[0]).toMatchObject({ outcome: "incorrect", awarded: 0 });
    expect(r.negativeMarks).toBe(0);
  });

  it("floors the total at zero", () => {
    const a = snap("MCQ_SINGLE", [true, false]);
    const r = calculateAttemptResult([q(a, 1, { selected: [a.options[1].id] }, { negativeMarks: 1 })]);
    expect(r.obtained).toBe(0);
  });
});

describe("subjective answers", () => {
  it("are pending until marked, then combine with objective marks", () => {
    const mcq = snap("MCQ_SINGLE", [true, false]);
    const essay = snap("LONG_ANSWER");
    const blank = snap("SHORT_ANSWER");
    const pending = calculateAttemptResult([q(mcq, 2, { selected: [mcq.options[0].id] }), q(essay, 10, { text: "My essay" }), q(blank, 5, null)]);
    expect(pending).toMatchObject({ complete: false, obtained: null, percentage: null, provisional: 2, maxMarks: 17 });
    expect(pending.questions.map((x) => x.outcome)).toEqual(["correct", "pending", "unanswered"]);

    const done = calculateAttemptResult([q(mcq, 2, { selected: [mcq.options[0].id] }), q(essay, 10, { text: "My essay", awarded: 7.5 }), q(blank, 5, null)]);
    expect(done).toMatchObject({ complete: true, obtained: 9.5, objectiveMarks: 2, subjectiveMarks: 7.5, percentage: 55.88 });
    expect(done.counts).toMatchObject({ evaluated: 1, pending: 0, unanswered: 1 });
  });

  it("treats whitespace-only text as unanswered (no examiner needed)", () => {
    const essay = snap("SHORT_ANSWER");
    expect(calculateAttemptResult([q(essay, 5, { text: "   " })]).questions[0].outcome).toBe("unanswered");
  });
});

describe("section rules and groups", () => {
  it("counts only the best N items in N-rule sections, matching the maximum", () => {
    const section = { id: "s1", attemptRule: "BEST_N" as const, attemptCount: 2 };
    const qs = [snap("MCQ_SINGLE", [true, false]), snap("MCQ_SINGLE", [true, false]), snap("MCQ_SINGLE", [true, false])];
    const r = calculateAttemptResult([
      q(qs[0], 2, { selected: [qs[0].options[0].id] }, { section }),
      q(qs[1], 5, { selected: [qs[1].options[1].id] }, { section }),
      q(qs[2], 3, { selected: [qs[2].options[0].id] }, { section }),
    ]);
    expect(r).toMatchObject({ maxMarks: 8, obtained: 5 });
  });

  it("scores a case study as one item made of its sub-questions", () => {
    const section = { id: "s1", attemptRule: "ANY_N" as const, attemptCount: 1 };
    const a = snap("SHORT_ANSWER");
    const b = snap("SHORT_ANSWER");
    const single = snap("MCQ_SINGLE", [true, false]);
    const r = calculateAttemptResult([
      q(a, 4, { text: "x", awarded: 3 }, { section, itemKey: "case1" }),
      q(b, 6, { text: "y", awarded: 5 }, { section, itemKey: "case1" }),
      q(single, 5, { selected: [single.options[0].id] }, { section }),
    ]);
    expect(r).toMatchObject({ maxMarks: 10, obtained: 8 });
  });
});
