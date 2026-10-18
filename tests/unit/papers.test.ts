import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "@/lib/papers/csv";
import { interpretTemplateRows } from "@/lib/papers/import-template";
import { attemptRuleText, canEditPaper, paperReadinessIssues, sectionMaxMarks } from "@/lib/papers/rules";
import { importPayloadSchema, sectionSchema } from "@/lib/validation/paper";

const HEADER = "section,section_rule,section_count,group,group_type,group_text,passage,type,question,option_a,option_b,option_c,option_d,correct,marks,negative_marks,topic,difficulty";
const csv = (...rows: string[]) => parseCsv([HEADER, ...rows].join("\n"));

describe("parseCsv", () => {
  it("reads quoted fields, escaped quotes, embedded commas and line breaks", () => {
    expect(parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
    ]);
  });

  it("ignores a UTF-8 BOM and keeps empty cells", () => {
    expect(parseCsv("﻿a,,c")).toEqual([["a", "", "c"]]);
  });

  it("reports an unclosed quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvError);
  });
});

describe("interpretTemplateRows", () => {
  it("imports the shipped template (public/templates/question-paper-template.csv) cleanly", () => {
    const text = readFileSync(new URL("../../public/templates/question-paper-template.csv", import.meta.url), "utf8");
    const result = interpretTemplateRows(parseCsv(text));
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ rows: 8, sections: 3, questions: 8, groups: 1, invalidRows: 0 });
    expect(importPayloadSchema.safeParse(result.payload).success).toBe(true);
  });

  it("builds sections, ordered questions and case-study groups from valid rows", () => {
    const result = interpretTemplateRows(
      csv(
        "Section A — Objective,ANY_N,2,,,,,MCQ,What is AI?,A field,A fruit,,,A,2,0.5,Basics,easy",
        "Section A — Objective,,,,,,,MCQ_MULTI,Pick ML methods,Regression,Painting,Clustering,,\"A,C\",2,,Basics,",
        "Section A — Objective,,,,,,,TRUE_FALSE,Transformers use attention.,,,,,true,1,,,",
        "Section B — Case,,,C1,CASE_STUDY,Read the case,An airline wants to cut delays…,SHORT_ANSWER,What is the main problem?,,,,,,5,,,",
        "Section B — Case,,,C1,,,,LONG_ANSWER,Propose an AI solution.,,,,,,10,,,hard",
      ),
    );

    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ rows: 5, sections: 2, questions: 5, groups: 1, invalidRows: 0 });
    const [a, b] = result.payload.sections;
    expect(a).toMatchObject({ title: "Section A — Objective", attemptRule: "ANY_N", attemptCount: "2", isRequired: true });
    expect(a.items.map((i) => (i.kind === "question" ? i.question.text : ""))).toEqual(["What is AI?", "Pick ML methods", "Transformers use attention."]);
    expect(a.items[1]).toMatchObject({ question: { type: "MCQ_MULTI", options: [{ isCorrect: true }, { isCorrect: false }, { isCorrect: true }] } });
    expect(a.items[2]).toMatchObject({ question: { options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }] } });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "group", group: { groupType: "CASE_STUDY", text: "Read the case" }, children: [{ type: "SHORT_ANSWER" }, { type: "LONG_ANSWER", difficulty: "HARD" }] });
    expect(result.sourceRows).toEqual([[2, 3, 4], [5]]);
    // The interpreted payload passes the same schema the save step uses.
    expect(importPayloadSchema.safeParse(result.payload).success).toBe(true);
  });

  it("reports clear row-level errors for invalid data", () => {
    const { issues, summary } = interpretTemplateRows(
      csv(
        ",,,,,,,MCQ,No section,A,B,,,A,1,,,",
        "S1,,,,,,,ESSAY,Unknown type,,,,,,1,,,",
        "S1,,,,,,,MCQ,No correct answer,A,B,,,,1,,,",
        "S1,,,,,,,MCQ,Points at empty option,A,B,,,D,1,,,",
        "S1,,,,,,,MCQ,Gap in options,A,,C,,A,1,,,",
        "S1,,,,,,,MCQ,,A,B,,,A,1,,,",
        "S1,,,,,,,SHORT_ANSWER,Bad marks,,,,,,abc,,,",
        "S1,,,,,,,MCQ,Too much negative,A,B,,,A,1,3,,",
        "S1,,,,,,,TRUE_FALSE,Missing truth,,,,,maybe,1,,,",
      ),
    );
    const at = (row: number) => issues.filter((i) => i.row === row).map((i) => `${i.field}: ${i.message}`);
    expect(at(2)).toEqual(["section: Section is required."]);
    expect(at(3)).toEqual(["type: Unknown question type “ESSAY”."]);
    expect(at(4)[0]).toMatch(/^correct: Set the correct answer/);
    expect(at(5)).toContain("correct: The correct answer points to an empty option.");
    expect(at(6)).toContain("options: Fill options in order (A, B, C…) without gaps.");
    expect(at(7)).toContain("question: Question text is required");
    expect(at(8)[0]).toMatch(/^marks: /);
    expect(at(9)).toContain("negative_marks: Negative marks cannot exceed the question's marks");
    expect(at(10)).toEqual(["correct: Set correct to TRUE or FALSE."]);
    expect(summary.invalidRows).toBe(9);
  });

  it("flags duplicates, invalid attempt rules and missing columns", () => {
    const dup = interpretTemplateRows(csv("S1,BEST_N,,,,,,MCQ,Same,A,B,,,A,1,,,", "S1,,,,,,,MCQ,  same ,A,B,,,B,1,,,"));
    expect(dup.issues).toEqual([
      { row: 2, field: "section_count", message: "Enter how many questions (N)" },
      { row: 3, field: "question", message: "Duplicate of row 2." },
    ]);

    const rule = interpretTemplateRows(csv("S1,SOMETIMES,,,,,,MCQ,Q,A,B,,,A,1,,,"));
    expect(rule.issues[0]).toMatchObject({ row: 2, field: "section_rule" });

    const missing = interpretTemplateRows(parseCsv("section,question\nS1,What?"));
    expect(missing.issues).toEqual([{ row: 1, message: "Missing required columns: type, marks. Use the question paper template." }]);
    expect(missing.payload.sections).toEqual([]);
  });

  it("requires group_text on a group's first row and keeps a group in one section", () => {
    const { issues } = interpretTemplateRows(
      csv("S1,,,G1,,,,SHORT_ANSWER,Part one,,,,,,2,,,", "S2,,,G1,,Prompt,,SHORT_ANSWER,Part two,,,,,,2,,,"),
    );
    expect(issues.map((i) => [i.row, i.field])).toEqual([
      [2, "group_text"],
      [3, "group"],
    ]);
  });

  it("accepts OPTIONAL / COMPULSORY rule names from the prototype", () => {
    const { payload, issues } = interpretTemplateRows(csv("S1,OPTIONAL,,,,,,SHORT_ANSWER,Q1,,,,,,2,,,", "S2,COMPULSORY,,,,,,SHORT_ANSWER,Q2,,,,,,2,,,"));
    expect(issues).toEqual([]);
    expect(payload.sections.map((s) => [s.attemptRule, s.isRequired])).toEqual([
      ["ALL", false],
      ["ALL", true],
    ]);
  });
});

describe("section rules", () => {
  it("validates attempt rule configuration", () => {
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "ALL" }).success).toBe(true);
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "BEST_N", attemptCount: 3 }).success).toBe(true);
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "BEST_N" }).success).toBe(false);
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "ALL", attemptCount: 2 }).success).toBe(false);
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "EXACTLY_N", attemptCount: 0 }).success).toBe(false);
    expect(sectionSchema.safeParse({ title: "A", attemptRule: "SOME" }).success).toBe(false);
    expect(sectionSchema.safeParse({ title: "" }).success).toBe(false);
    expect(sectionSchema.parse({ title: "Optional part", isRequired: false })).toMatchObject({ isRequired: false, attemptRule: "ALL", attemptCount: null });
  });

  it("computes the maximum marks a section can contribute", () => {
    expect(sectionMaxMarks("ALL", null, [2, 3, 5])).toBe(10);
    expect(sectionMaxMarks("BEST_N", 2, [2, 3, 5])).toBe(8);
    expect(sectionMaxMarks("ANY_N", 1, [4, 4])).toBe(4);
    expect(attemptRuleText("ANY_N", 5, 8)).toBe("Attempt any 5 of 8");
  });

  it("lists what blocks submission", () => {
    expect(
      paperReadinessIssues([
        { title: "A", attemptRule: "EXACTLY_N", attemptCount: 3, items: [{ kind: "question", marks: 2, childCount: 0, number: "1" }] },
        { title: "B", attemptRule: "ALL", attemptCount: null, items: [] },
        { title: "C", attemptRule: "ALL", attemptCount: null, items: [{ kind: "group", marks: 0, childCount: 0, number: "2" }, { kind: "question", marks: 0, childCount: 0, number: "3" }] },
      ]),
    ).toEqual(["“A” asks for 3 questions but has only 1.", "“B” has no questions.", "Q2 (case/passage) has no sub-questions.", "Q3 has no marks."]);
    expect(paperReadinessIssues([])).toEqual(["Add at least one section."]);
    // Editable until an assessment uses the paper (there is no review state).
    expect([canEditPaper(0), canEditPaper(1), canEditPaper(3)]).toEqual([true, false, false]);
  });
});
