import { describe, expect, it } from "vitest";
import { parseIstInput, toIstInput } from "@/lib/datetime";
import { isQuestionCompatible } from "@/lib/questions/types";
import { addLearnerSchema, createBatchSchema, createCourseSchema, updateBatchSchema } from "@/lib/validation/academic";
import { createAssessmentSchema, updateAssessmentSchema } from "@/lib/validation/assessment";
import { questionInputSchema } from "@/lib/validation/question";

const base = { text: "What is 2 + 2?", marks: 2, negativeMarks: 0, difficulty: "EASY" as const };
const opts = (...correct: boolean[]) => correct.map((isCorrect, i) => ({ text: `Option ${i + 1}`, isCorrect }));

function errorsOf(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("question validation", () => {
  it("requires question text", () => {
    const r = questionInputSchema.safeParse({ ...base, text: "   ", type: "SHORT_ANSWER" });
    expect(errorsOf(r)).toContain("text: Question text is required");
  });

  it("rejects negative marks and non-numeric marks", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "SHORT_ANSWER", marks: -1 }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...base, type: "SHORT_ANSWER", marks: "abc" }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...base, type: "SHORT_ANSWER", marks: 1.234 }).success).toBe(false);
  });

  it("allows zero marks", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "SHORT_ANSWER", marks: 0 }).success).toBe(true);
  });

  it("MCQ_SINGLE needs exactly one correct option", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: opts(true, false, false) }).success).toBe(true);
    expect(errorsOf(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: opts(true, true, false) }))).toContain(
      "options: Mark exactly one option as correct",
    );
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: opts(false, false) }).success).toBe(false);
  });

  it("MCQ_MULTI needs at least one correct option", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_MULTI", options: opts(true, true, false) }).success).toBe(true);
    expect(errorsOf(questionInputSchema.safeParse({ ...base, type: "MCQ_MULTI", options: opts(false, false) }))).toContain(
      "options: Mark at least one option as correct",
    );
  });

  it("MCQs need 2–10 non-empty, unique options", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: opts(true) }).success).toBe(false);
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_MULTI", options: opts(...Array(11).fill(true)) }).success).toBe(false);
    const blank = [{ text: "", isCorrect: true }, { text: "B", isCorrect: false }];
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: blank }).success).toBe(false);
    const dupes = [{ text: "Same", isCorrect: true }, { text: "same", isCorrect: false }];
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: dupes }).success).toBe(false);
  });

  it("accepts options as the JSON string the form sends", () => {
    const r = questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", options: JSON.stringify(opts(false, true)) });
    expect(r.success).toBe(true);
  });

  it("negative marks cannot exceed marks", () => {
    const r = questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", marks: 1, negativeMarks: 2, options: opts(true, false) });
    expect(errorsOf(r)).toContain("negativeMarks: Negative marks cannot exceed the question's marks");
    expect(questionInputSchema.safeParse({ ...base, type: "MCQ_SINGLE", negativeMarks: -0.5, options: opts(true, false) }).success).toBe(false);
  });

  it("subjective questions cannot carry negative marks and drop options", () => {
    expect(questionInputSchema.safeParse({ ...base, type: "LONG_ANSWER", negativeMarks: 1 }).success).toBe(false);
    const r = questionInputSchema.parse({ ...base, type: "SHORT_ANSWER", options: opts(true, false) });
    expect(r.options).toEqual([]);
    expect(r.negativeMarks).toBe(0);
  });

  it("TRUE_FALSE normalises to fixed True/False options", () => {
    const r = questionInputSchema.parse({
      ...base,
      type: "TRUE_FALSE",
      options: [{ text: "whatever", isCorrect: false }, { text: "x", isCorrect: true }],
    });
    expect(r.options).toEqual([
      { text: "True", isCorrect: false },
      { text: "False", isCorrect: true },
    ]);
    expect(questionInputSchema.safeParse({ ...base, type: "TRUE_FALSE", options: [] }).success).toBe(false);
  });

  it("treats blank optional fields as null", () => {
    const r = questionInputSchema.parse({ ...base, type: "SHORT_ANSWER", topic: "  ", guidance: "", courseId: "" });
    expect(r).toMatchObject({ topic: null, guidance: null, courseId: null });
  });
});

describe("question/assessment type compatibility", () => {
  it("matches kinds", () => {
    expect(isQuestionCompatible("OBJECTIVE", "MCQ_MULTI")).toBe(true);
    expect(isQuestionCompatible("OBJECTIVE", "LONG_ANSWER")).toBe(false);
    expect(isQuestionCompatible("SUBJECTIVE", "SHORT_ANSWER")).toBe(true);
    expect(isQuestionCompatible("SUBJECTIVE", "TRUE_FALSE")).toBe(false);
    expect(isQuestionCompatible("MIXED", "TRUE_FALSE")).toBe(true);
    expect(isQuestionCompatible("MIXED", "LONG_ANSWER")).toBe(true);
  });
});

describe("assessment validation", () => {
  const valid = {
    name: "Mid-term",
    description: "",
    batchId: "b1",
    type: "OBJECTIVE",
    durationMinutes: "60",
    startAt: "2026-10-01T10:00",
    endAt: "2026-10-01T12:00",
    maxAttempts: "1",
    passingMarks: "4",
    resultVisibility: "ON_PUBLISH",
    proctoringEnabled: "on",
  };

  it("parses form strings into typed values (IST)", () => {
    const v = createAssessmentSchema.parse(valid);
    expect(v.startAt.toISOString()).toBe("2026-10-01T04:30:00.000Z");
    expect(v.durationMinutes).toBe(60);
    expect(v.proctoringEnabled).toBe(true);
    expect(v.description).toBeNull();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["short name", { name: "ab" }, "name"],
    // No course is chosen any more; the batch is what's required.
    ["missing batch", { batchId: "" }, "batchId"],
    ["bad type", { type: "ORAL" }, "type"],
    ["zero duration", { durationMinutes: "0" }, "durationMinutes"],
    ["fractional duration", { durationMinutes: "1.5" }, "durationMinutes"],
    ["too many attempts", { maxAttempts: "11" }, "maxAttempts"],
    ["zero attempts", { maxAttempts: "0" }, "maxAttempts"],
    ["negative passing marks", { passingMarks: "-1" }, "passingMarks"],
    ["bad date", { startAt: "tomorrow" }, "startAt"],
    ["end before start", { endAt: "2026-10-01T09:00" }, "endAt"],
    ["window shorter than duration", { endAt: "2026-10-01T10:30" }, "endAt"],
    ["immediate results on non-objective", { type: "MIXED", resultVisibility: "IMMEDIATE" }, "resultVisibility"],
  ])("rejects %s", (_label, override, field) => {
    const r = createAssessmentSchema.safeParse({ ...valid, ...override });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0])).toContain(field);
  });

  it("allows immediate results for objective assessments", () => {
    expect(createAssessmentSchema.safeParse({ ...valid, resultVisibility: "IMMEDIATE" }).success).toBe(true);
  });

  it("partial updates leave omitted fields undefined (not defaulted)", () => {
    const r = updateAssessmentSchema.parse({ endAt: "2026-10-01T13:00" });
    expect(r.endAt).toBeInstanceOf(Date);
    expect(r.proctoringEnabled).toBeUndefined();
    expect(r.description).toBeUndefined();
    expect(r.name).toBeUndefined();
    // Enum fields with a create-time default must not be reset by an update that omits them.
    expect(r.resultVisibility).toBeUndefined();
    expect(r.resultDetail).toBeUndefined();
    expect(r.timingMode).toBeUndefined();
  });
});

describe("IST date helpers", () => {
  it("round-trips datetime-local values", () => {
    const d = parseIstInput("2026-12-31T23:45")!;
    expect(d.toISOString()).toBe("2026-12-31T18:15:00.000Z");
    expect(toIstInput(d)).toBe("2026-12-31T23:45");
  });

  it("rejects malformed input", () => {
    expect(parseIstInput("2026-13-01T10:00")).toBeNull();
    expect(parseIstInput("01/10/2026 10:00")).toBeNull();
  });

  it("rejects dates that don't exist instead of rolling them over", () => {
    expect(parseIstInput("2027-02-31T09:00")).toBeNull();
    expect(parseIstInput("2026-04-31T10:00")).toBeNull();
    expect(parseIstInput("2026-10-01T24:30")).toBeNull();
    expect(parseIstInput("2028-02-29T09:00")?.toISOString()).toBe("2028-02-29T03:30:00.000Z");
  });
});

describe("academic schemas", () => {
  it("normalises course codes and requires a name", () => {
    expect(createCourseSchema.parse({ code: " ai-101 ", name: " AI for Leaders " })).toEqual({ code: "AI-101", name: "AI for Leaders", description: null });
    expect(errorsOf(createCourseSchema.safeParse({ code: "AI 1", name: "" }))).toEqual([
      "code: Use letters, numbers and hyphens only",
      "name: Course name is required",
    ]);
  });

  it("needs a batch name and course; code and dates are optional", () => {
    expect(createBatchSchema.parse({ name: "AI Leaders - September 2026", courseId: "c1", code: "" })).toMatchObject({ code: null });
    expect(errorsOf(createBatchSchema.safeParse({}))).toEqual(["name: Batch name is required", "courseId: Choose a course"]);
    expect(createBatchSchema.parse({ name: "Batch A", courseId: "c1", startDate: "2026-09-01" }).startDate?.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(errorsOf(updateBatchSchema.safeParse({ startDate: "2026-09-10", endDate: "2026-09-01" }))).toEqual(["endDate: End date must be on or after the start date"]);
  });

  it("requires name, a valid email and a batch to add a learner", () => {
    expect(addLearnerSchema.parse({ name: "Rahul Sharma", email: " RAHUL@Gmail.com", batchId: "b1" }).email).toBe("rahul@gmail.com");
    expect(errorsOf(addLearnerSchema.safeParse({ name: "R", email: "nope" }))).toEqual([
      "name: Name must be at least 2 characters",
      "email: Enter a valid email address",
      "batchId: Choose a batch",
    ]);
  });
});
