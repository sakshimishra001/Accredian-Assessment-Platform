import { describe, expect, it } from "vitest";
import { buildSnapshot, snapshotDiffers, type QuestionSnapshot } from "@/lib/questions/snapshot";
import {
  answerKey,
  answerKeyProblems,
  maxTotal,
  scoreObjectiveAnswer,
  totalObjectiveScore,
  type ScorableQuestion,
} from "@/lib/scoring/objective";

function snap(type: QuestionSnapshot["type"], correct: boolean[], overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    questionId: "q1",
    version: 1,
    type,
    text: "Question",
    guidance: null,
    topic: null,
    difficulty: "MEDIUM",
    options: correct.map((isCorrect, i) => ({ id: `o${i + 1}`, text: `Option ${i + 1}`, isCorrect, position: i })),
    ...overrides,
  };
}

const q = (snapshot: QuestionSnapshot, marks = 2, negativeMarks = 0.5): ScorableQuestion => ({ snapshot, marks, negativeMarks });

describe("answer key", () => {
  it("lists correct option ids in display order", () => {
    const s = snap("MCQ_MULTI", [true, false, true]);
    s.options.reverse(); // stored out of order
    expect(answerKey(s)).toEqual(["o1", "o3"]);
  });

  it.each<[string, QuestionSnapshot, RegExp | null]>([
    ["valid single", snap("MCQ_SINGLE", [false, true, false]), null],
    ["valid multi", snap("MCQ_MULTI", [true, true, false]), null],
    ["valid true/false", snap("TRUE_FALSE", [false, true]), null],
    ["valid subjective", snap("LONG_ANSWER", []), null],
    ["single with two correct", snap("MCQ_SINGLE", [true, true]), /Exactly one/],
    ["single with none correct", snap("MCQ_SINGLE", [false, false]), /Exactly one/],
    ["multi with none correct", snap("MCQ_MULTI", [false, false]), /At least one/],
    ["true/false with three options", snap("TRUE_FALSE", [true, false, false]), /exactly 2/],
    ["mcq with one option", snap("MCQ_SINGLE", [true]), /at least 2/],
    ["subjective with options", snap("SHORT_ANSWER", [true, false]), /must not have options/],
  ])("%s", (_label, s, problem) => {
    const problems = answerKeyProblems(s);
    if (problem) expect(problems.join(" ")).toMatch(problem);
    else expect(problems).toEqual([]);
  });

  it("flags duplicate option ids", () => {
    const s = snap("MCQ_SINGLE", [true, false]);
    s.options[1].id = "o1";
    expect(answerKeyProblems(s)).toContain("Option ids must be unique");
  });
});

describe("scoreObjectiveAnswer — single answer and true/false", () => {
  const single = q(snap("MCQ_SINGLE", [false, true, false]));

  it("awards full marks for the correct option", () => {
    expect(scoreObjectiveAnswer(single, ["o2"])).toEqual({ outcome: "correct", score: 2, maxScore: 2 });
  });

  it("deducts negative marks for a wrong option", () => {
    expect(scoreObjectiveAnswer(single, ["o1"])).toEqual({ outcome: "incorrect", score: -0.5, maxScore: 2 });
  });

  it("scores 0 when unanswered", () => {
    expect(scoreObjectiveAnswer(single, [])).toEqual({ outcome: "unanswered", score: 0, maxScore: 2 });
  });

  it("treats selecting several options on a single-answer question as wrong", () => {
    expect(scoreObjectiveAnswer(single, ["o1", "o2"]).outcome).toBe("incorrect");
  });

  it("ignores ids that are not options of this question", () => {
    expect(scoreObjectiveAnswer(single, ["bogus"]).outcome).toBe("unanswered");
    expect(scoreObjectiveAnswer(single, ["bogus", "o2"]).outcome).toBe("correct");
  });

  it("gives 0 (not -0) for a wrong answer without negative marking", () => {
    const r = scoreObjectiveAnswer(q(snap("TRUE_FALSE", [true, false]), 1, 0), ["o2"]);
    expect(r.outcome).toBe("incorrect");
    expect(Object.is(r.score, 0)).toBe(true);
  });

  it("scores true/false", () => {
    const tf = q(snap("TRUE_FALSE", [false, true]), 1, 0.25);
    expect(scoreObjectiveAnswer(tf, ["o2"]).score).toBe(1);
    expect(scoreObjectiveAnswer(tf, ["o1"]).score).toBe(-0.25);
  });
});

describe("scoreObjectiveAnswer — multiple answer (all-or-nothing)", () => {
  const multi = q(snap("MCQ_MULTI", [true, false, true, false]), 3, 1);

  it("awards full marks only for the exact correct set, in any order", () => {
    expect(scoreObjectiveAnswer(multi, ["o3", "o1"]).score).toBe(3);
  });

  it.each([[["o1"]], [["o1", "o2", "o3"]], [["o2", "o4"]]])("treats %j as wrong", (sel) => {
    expect(scoreObjectiveAnswer(multi, sel)).toMatchObject({ outcome: "incorrect", score: -1 });
  });

  it("ignores duplicate selections", () => {
    expect(scoreObjectiveAnswer(multi, ["o1", "o1", "o3"]).outcome).toBe("correct");
  });
});

describe("scoring guards", () => {
  it("refuses to score subjective questions", () => {
    expect(() => scoreObjectiveAnswer(q(snap("SHORT_ANSWER", [])), [])).toThrow(/not objectively scorable/);
  });

  it("refuses to score a malformed answer key", () => {
    expect(() => scoreObjectiveAnswer(q(snap("MCQ_SINGLE", [true, true])), ["o1"])).toThrow(/Invalid answer key/);
  });
});

describe("totals", () => {
  it("adds quarter marks without floating-point drift", () => {
    expect(totalObjectiveScore([{ score: 0.1 }, { score: 0.2 }, { score: 0.25 }])).toBe(0.55);
    expect(maxTotal([{ marks: 0.1 }, { marks: 0.2 }])).toBe(0.3);
  });

  it("floors the total at zero", () => {
    expect(totalObjectiveScore([{ score: -1 }, { score: -0.5 }, { score: 1 }])).toBe(0);
    expect(totalObjectiveScore([{ score: -1 }, { score: 3 }])).toBe(2);
  });
});

describe("snapshots", () => {
  const bankQuestion = {
    id: "q1",
    version: 3,
    type: "MCQ_SINGLE" as const,
    text: "Pick one",
    guidance: null,
    topic: "T",
    difficulty: "EASY" as const,
    options: [
      { id: "b", text: "B", isCorrect: true, position: 1, questionId: "q1" },
      { id: "a", text: "A", isCorrect: false, position: 0, questionId: "q1" },
    ],
  };

  it("records the source version and orders options without extra columns", () => {
    const s = buildSnapshot(bankQuestion);
    expect(s.version).toBe(3);
    expect(s.options).toEqual([
      { id: "a", text: "A", isCorrect: false, position: 0 },
      { id: "b", text: "B", isCorrect: true, position: 1 },
    ]);
  });

  it("is a copy: mutating the source afterwards does not change it", () => {
    const s = buildSnapshot(bankQuestion);
    bankQuestion.options[0].text = "changed";
    expect(s.options[1].text).toBe("B");
    bankQuestion.options[0].text = "B";
  });

  it("detects content changes but ignores option id churn", () => {
    const a = buildSnapshot(bankQuestion);
    const renumbered = buildSnapshot({ ...bankQuestion, options: bankQuestion.options.map((o) => ({ ...o, id: `new-${o.id}` })) });
    expect(snapshotDiffers(a, renumbered)).toBe(false);
    expect(snapshotDiffers(a, buildSnapshot({ ...bankQuestion, text: "Pick one!" }))).toBe(true);
    const flipped = bankQuestion.options.map((o) => ({ ...o, isCorrect: !o.isCorrect }));
    expect(snapshotDiffers(a, buildSnapshot({ ...bankQuestion, options: flipped }))).toBe(true);
  });
});
