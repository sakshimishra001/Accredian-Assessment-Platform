import { describe, expect, it, vi } from "vitest";
import type { QuestionSnapshot } from "@/lib/questions/snapshot";

/*
 * Production report: "the objective result wasn't visible to the learner". Investigation showed the
 * objective answers were scored and the evaluation COMPLETED, and that the assessments used the
 * default visibility "When results are published" (ON_PUBLISH) — so learners see "Evaluation is
 * complete. Your result will appear here when it is published." until an administrator publishes.
 * These tests pin that behaviour with the real scoring and visibility rules.
 */

vi.mock("@/server/db", () => ({ db: {} }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");
const { resultOf, learnerResultState } = await import("@/server/services/results");

const dec = (n: number) => ({ toNumber: () => n });
let seq = 0;
function question(type: QuestionSnapshot["type"], correct: boolean[] = []) {
  const id = `q${++seq}`;
  const snapshot: QuestionSnapshot = { questionId: id, version: 1, type, text: id, guidance: null, topic: null, difficulty: "MEDIUM", options: correct.map((isCorrect, i) => ({ id: `${id}-o${i}`, text: `O${i}`, isCorrect, position: i })) };
  return { id: `aq-${id}`, snapshot, marks: dec(1), negativeMarks: dec(0), paperQuestion: null };
}

/** An attempt row as the results service loads it (only the fields scoring and visibility read). */
function row(opts: {
  questions: ReturnType<typeof question>[];
  answers: Record<string, { selected?: string[]; text?: string; awarded?: number }>;
  status?: string;
  evaluationStatus?: string;
  visibility?: "ON_PUBLISH" | "IMMEDIATE";
  publishedAt?: Date | null;
}) {
  return {
    status: opts.status ?? "SUBMITTED",
    evaluationStatus: opts.evaluationStatus ?? "COMPLETED",
    assessment: { resultVisibility: opts.visibility ?? "ON_PUBLISH", publishedAt: opts.publishedAt ?? null, negativeMarking: false, passingMarks: dec(0), questions: opts.questions },
    responses: Object.entries(opts.answers).map(([assessmentQuestionId, a]) => ({
      assessmentQuestionId,
      selectedOptionIds: a.selected ?? [],
      textAnswer: a.text ?? null,
      awardedMarks: a.awarded === undefined ? null : dec(a.awarded),
      attachments: [],
    })),
  } as never;
}

describe("objective-only assessment", () => {
  const q1 = question("MCQ_SINGLE", [true, false]);
  const q2 = question("MCQ_SINGLE", [false, true]);
  const answers = { [q1.id]: { selected: [`${q1.snapshot.questionId}-o0`] }, [q2.id]: { selected: [`${q2.snapshot.questionId}-o0`] } };

  it("is scored and final on submission (1 of 2 correct)", () => {
    const r = resultOf(row({ questions: [q1, q2], answers }));
    expect(r).toMatchObject({ final: true, obtained: 1, maxMarks: 2 });
  });

  it("ON_PUBLISH: awaiting publication until the administrator publishes — then available", () => {
    const unpublished = row({ questions: [q1, q2], answers });
    expect(learnerResultState(unpublished, resultOf(unpublished).final)).toBe("AWAITING_PUBLICATION");
    const published = row({ questions: [q1, q2], answers, publishedAt: new Date("2026-11-02T05:56:32Z") });
    expect(learnerResultState(published, resultOf(published).final)).toBe("AVAILABLE");
  });

  it("IMMEDIATE: available as soon as the attempt is submitted (no publication step)", () => {
    const r = row({ questions: [q1, q2], answers, visibility: "IMMEDIATE" });
    expect(learnerResultState(r, resultOf(r).final)).toBe("AVAILABLE");
  });

  it("an auto-submitted attempt is scored the same; an in-progress or terminated one shows no result", () => {
    const auto = row({ questions: [q1, q2], answers, status: "AUTO_SUBMITTED", publishedAt: new Date() });
    expect(learnerResultState(auto, resultOf(auto).final)).toBe("AVAILABLE");
    const running = row({ questions: [q1, q2], answers, status: "IN_PROGRESS", publishedAt: new Date() });
    expect(learnerResultState(running, resultOf(running).final)).toBe("IN_PROGRESS");
    const terminated = row({ questions: [q1, q2], answers, status: "TERMINATED", publishedAt: new Date() });
    expect(learnerResultState(terminated, resultOf(terminated).final)).toBe("TERMINATED");
  });
});

describe("mixed objective + subjective assessment", () => {
  const mcq = question("MCQ_SINGLE", [true, false]);
  const written = question("SHORT_ANSWER");

  it("pending evaluation until the written answer is marked and the evaluation completed — even if published", () => {
    const pending = row({ questions: [mcq, written], answers: { [mcq.id]: { selected: [`${mcq.snapshot.questionId}-o0`] }, [written.id]: { text: "An answer" } }, evaluationStatus: "PENDING", publishedAt: new Date() });
    expect(resultOf(pending).final).toBe(false);
    expect(learnerResultState(pending, resultOf(pending).final)).toBe("EVALUATION_PENDING");
    const marked = row({ questions: [mcq, written], answers: { [mcq.id]: { selected: [`${mcq.snapshot.questionId}-o0`] }, [written.id]: { text: "An answer", awarded: 1 } }, publishedAt: new Date() });
    expect(resultOf(marked)).toMatchObject({ final: true, obtained: 2, maxMarks: 2 });
    expect(learnerResultState(marked, resultOf(marked).final)).toBe("AVAILABLE");
  });
});
