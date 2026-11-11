import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Production bug: "Create paper & import 50 questions" failed after 60 s with P2028 (transaction
 * expired) — the import ran ~10 sequential queries per question inside one interactive transaction.
 * These tests run the real CSV template parser and import service against an in-memory database
 * that records every query and applies writes only when the transaction commits: the import must
 * use a fixed number of queries however large it is, write exactly the same rows as before, stay
 * all-or-nothing, and report failures clearly.
 */

type Row = Record<string, unknown> & { id: string };
type Tables = Record<"courses" | "papers" | "sections" | "questions" | "options" | "items" | "audits", Row[]>;
const empty = (): Tables => ({ courses: [], papers: [], sections: [], questions: [], options: [], items: [], audits: [] });
let committed: Tables = empty();
let calls: string[] = [];
let failOn: string | null = null;
let failWith: unknown = null;
let transactions = 0;

function makeTx(t: Tables) {
  const op = (name: string) => {
    calls.push(name);
    if (failOn === name) throw failWith;
  };
  let seq = 0;
  return {
    course: { findUnique: async ({ where }: { where: { id: string } }) => (op("course.findUnique"), t.courses.find((c) => c.id === where.id) ?? null) },
    questionPaper: {
      create: async ({ data }: { data: Row }) => {
        op("questionPaper.create");
        const p: Row = { ...data, id: `paper-${++seq}`, status: "DRAFT", version: 1 };
        t.papers.push(p);
        return { id: p.id, name: p.name, status: p.status, version: 1, courseId: p.courseId };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => (op("questionPaper.update"), Object.assign(t.papers.find((p) => p.id === where.id)!, data)),
      findUnique: async ({ where }: { where: { id: string } }) => {
        op("questionPaper.findUnique");
        const p = t.papers.find((x) => x.id === where.id);
        return p ? { id: p.id, courseId: p.courseId, _count: { assessments: 0 } } : null;
      },
    },
    paperSection: {
      createMany: async ({ data }: { data: Row[] }) => (op("paperSection.createMany"), t.sections.push(...data), { count: data.length }),
      findMany: async ({ where }: { where: { paperId: string } }) => (op("paperSection.findMany"), t.sections.filter((s) => s.paperId === where.paperId)),
    },
    question: { createMany: async ({ data }: { data: Row[] }) => (op("question.createMany"), t.questions.push(...data), { count: data.length }) },
    questionOption: { createMany: async ({ data }: { data: Row[] }) => (op("questionOption.createMany"), t.options.push(...data), { count: data.length }) },
    paperQuestion: {
      createMany: async ({ data }: { data: Row[] }) => {
        op("paperQuestion.createMany");
        for (const d of data) if (d.parentId && !t.items.some((i) => i.id === d.parentId) && !data.some((x) => x.id === d.parentId)) throw new Error("FK: parent group missing");
        t.items.push(...data);
        return { count: data.length };
      },
      findMany: async ({ where }: { where: { paperId: string } }) => (op("paperQuestion.findMany"), t.items.filter((i) => i.paperId === where.paperId && i.questionId)),
      groupBy: async ({ where }: { where: { paperId: string; parentId: null } }) => {
        op("paperQuestion.groupBy");
        const max = new Map<string, number>();
        for (const i of t.items.filter((x) => x.paperId === where.paperId && !x.parentId)) max.set(i.sectionId as string, Math.max(max.get(i.sectionId as string) ?? 0, i.position as number));
        return [...max].map(([sectionId, position]) => ({ sectionId, _max: { position } }));
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => (op("auditLog.create"), t.audits.push({ ...data, id: `a${t.audits.length}` })),
      createMany: async ({ data }: { data: Row[] }) => (op("auditLog.createMany"), t.audits.push(...data.map((d, k) => ({ ...d, id: `am${t.audits.length + k}` }))), { count: data.length }),
    },
  };
}

const fakeDb = {
  /** Interactive transaction: works on a copy, committed only if the callback succeeds. */
  $transaction: async <T,>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
    transactions++;
    const draft: Tables = JSON.parse(JSON.stringify(committed));
    const result = await fn(makeTx(draft));
    committed = draft;
    return result;
  },
};

vi.mock("@/server/db", () => ({ db: fakeDb }));
vi.stubEnv("DATABASE_URL", "postgresql://unit:unit@localhost:5432/unit_test");

const { createPaperFromImport, saveImportToPaper, parseQuestionImport } = await import("@/server/services/question-import");
const { Prisma } = await import("@/generated/prisma/client");
const { ConflictError, ValidationError } = await import("@/lib/errors");
const { buildSnapshot } = await import("@/lib/questions/snapshot");
const { TEMPLATE_COLUMNS } = await import("@/lib/papers/import-template");

const admin = { id: "admin", email: "a@example.com", name: "Admin", role: "ADMIN" as const };
const details = { name: "Imported paper", courseId: "course-1" };

/** A CSV in the import template: `n` MCQ_SINGLE rows, 4 options, correct answers A/B/C/D, marks and negative marks. */
function mcqCsv(n: number, section = "Section A") {
  const header = TEMPLATE_COLUMNS.join(",");
  const rows = Array.from({ length: n }, (_, k) => {
    const r: Record<string, string> = {
      section,
      type: "MCQ_SINGLE",
      question: `Question ${k + 1}: which option is right?`,
      option_a: `Q${k + 1} A`,
      option_b: `Q${k + 1} B`,
      option_c: `Q${k + 1} C`,
      option_d: `Q${k + 1} D`,
      correct: "ABCD"[k % 4],
      marks: "2",
      negative_marks: "0.5",
      topic: "Algebra",
      difficulty: ["EASY", "MEDIUM", "HARD"][k % 3],
    };
    return TEMPLATE_COLUMNS.map((c) => r[c] ?? "").join(",");
  });
  return [header, ...rows].join("\n");
}
const parse = (csv: string, fileName = "paper.csv") => {
  const p = parseQuestionImport(admin, { fileName, content: csv });
  expect(p.issues).toEqual([]);
  return { ...p.payload, sourceFileName: fileName };
};

beforeEach(() => {
  committed = empty();
  committed.courses.push({ id: "course-1", isActive: true });
  calls = [];
  failOn = null;
  failWith = null;
  transactions = 0;
});

describe("create a paper and import 50 MCQs (the production case)", () => {
  it("parses the 23-column template: 50 MCQ_SINGLE rows, four options, A/B/C/D answers", () => {
    const payload = parse(mcqCsv(50));
    expect(TEMPLATE_COLUMNS).toHaveLength(23);
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].items).toHaveLength(50);
  });

  it("writes everything with a fixed handful of queries — none per question", async () => {
    const r = await createPaperFromImport(admin, details, parse(mcqCsv(50)));
    expect(r.summary).toEqual({ sectionsCreated: 1, questionsAdded: 50, groupsAdded: 0 });
    expect(transactions).toBe(1);
    expect(calls).toEqual([
      "course.findUnique",
      "questionPaper.create",
      "auditLog.create", // paper created
      "paperSection.createMany",
      "question.createMany",
      "questionOption.createMany",
      "paperQuestion.createMany",
      "auditLog.createMany", // 50 × question created
      "questionPaper.update",
      "auditLog.create", // paper imported
    ]);
    expect(calls).not.toContain("course.count");
  });

  it("creates exactly the rows adding questions one by one did: bank question, options, snapshot, marks, positions, audits", async () => {
    await createPaperFromImport(admin, details, parse(mcqCsv(50)));
    const { papers, sections, questions, options, items, audits } = committed;
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ name: "Imported paper", courseId: "course-1", sourceFileName: "paper.csv", createdById: "admin" });
    expect(sections).toEqual([expect.objectContaining({ paperId: papers[0].id, title: "Section A", position: 1, attemptCount: null })]);
    expect(questions).toHaveLength(50);
    expect(options).toHaveLength(200);
    expect(items).toHaveLength(50);
    expect(new Set([...questions, ...options, ...items].map((x) => x.id)).size).toBe(300); // unique ids
    for (const id of questions.map((q) => q.id)) expect(id).toMatch(/^c[0-9a-z]{24}$/);

    const q7 = questions[6];
    expect(q7).toMatchObject({ type: "MCQ_SINGLE", text: "Question 7: which option is right?", marks: 2, negativeMarks: 0.5, topic: "Algebra", difficulty: "EASY", courseId: "course-1", createdById: "admin" });
    const q7Options = options.filter((o) => o.questionId === q7.id).sort((a, b) => (a.position as number) - (b.position as number));
    expect(q7Options.map((o) => [o.text, o.isCorrect, o.position])).toEqual([
      ["Q7 A", false, 0],
      ["Q7 B", false, 1],
      ["Q7 C", true, 2], // row 7 → "C"
      ["Q7 D", false, 3],
    ]);
    const item7 = items.find((i) => i.questionId === q7.id)!;
    expect(item7).toMatchObject({ paperId: papers[0].id, sectionId: sections[0].id, parentId: null, position: 7, marks: 2, negativeMarks: 0.5, questionVersion: 1 });
    expect(item7.snapshot).toEqual(buildSnapshot({ ...q7, version: 1, options: q7Options } as unknown as Parameters<typeof buildSnapshot>[0]));
    expect(items.map((i) => i.position)).toEqual(Array.from({ length: 50 }, (_, k) => k + 1));
    expect(audits.filter((a) => a.action === "question.created")).toHaveLength(50);
    expect(audits.filter((a) => a.action === "question_paper.imported")).toEqual([expect.objectContaining({ metadata: { sectionsCreated: 1, questionsAdded: 50, groupsAdded: 0, sourceFileName: "paper.csv" } })]);
  });
});

describe("larger imports", () => {
  it("500 questions: one insert for the questions, the 2 000 options in four chunks — 13 queries in all", async () => {
    await createPaperFromImport(admin, details, parse(mcqCsv(500)));
    expect(committed.questions).toHaveLength(500);
    expect(calls.filter((c) => c === "question.createMany")).toHaveLength(1);
    expect(calls.filter((c) => c === "questionOption.createMany")).toHaveLength(4);
    expect(calls).toHaveLength(13);
  });

  it("1 000 questions (the template's maximum): inserted in chunks of 500 — a few statements, never one per question", async () => {
    await createPaperFromImport(admin, details, parse(mcqCsv(1000)));
    expect(committed.questions).toHaveLength(1000);
    expect(committed.options).toHaveLength(4000);
    expect(calls.filter((c) => c === "question.createMany")).toHaveLength(2);
    expect(calls.filter((c) => c === "questionOption.createMany")).toHaveLength(8);
    expect(calls.length).toBeLessThan(25);
  });
});

describe("sections and case-study groups", () => {
  it("groups come before their sub-questions; sub-questions are numbered within the group; sections keep their settings", async () => {
    const cols = TEMPLATE_COLUMNS;
    const line = (r: Record<string, string>) => cols.map((c) => r[c] ?? "").join(",");
    const csv = [
      cols.join(","),
      line({ section: "Part 1", section_rule: "ALL", type: "MCQ_SINGLE", question: "Standalone", option_a: "x", option_b: "y", correct: "A", marks: "1" }),
      line({ section: "Part 1", group: "G1", group_type: "CASE_STUDY", group_text: "Read the case", passage: "Once upon a time", type: "MCQ_SINGLE", question: "Sub one", option_a: "x", option_b: "y", correct: "B", marks: "2" }),
      line({ section: "Part 1", group: "G1", type: "SHORT_ANSWER", question: "Sub two", marks: "3" }),
      line({ section: "Part 2", type: "TRUE_FALSE", question: "The sky is blue", correct: "TRUE", marks: "1" }),
    ].join("\n");
    const r = await createPaperFromImport(admin, details, parse(csv));
    expect(r.summary).toEqual({ sectionsCreated: 2, questionsAdded: 4, groupsAdded: 1 });
    const { sections, items } = committed;
    expect(sections.map((s) => [s.title, s.position])).toEqual([
      ["Part 1", 1],
      ["Part 2", 2],
    ]);
    const group = items.find((i) => i.groupType === "CASE_STUDY")!;
    expect(group.questionId).toBeUndefined();
    expect(group).toMatchObject({ parentId: null, position: 2, snapshot: { kind: "group", groupType: "CASE_STUDY", text: "Read the case", passage: "Once upon a time" } });
    expect(items.filter((i) => i.parentId === group.id).map((i) => i.position)).toEqual([1, 2]);
    expect(calls.indexOf("paperQuestion.createMany")).toBeLessThan(calls.lastIndexOf("paperQuestion.createMany")); // groups, then items
  });
});

describe("importing into an existing draft paper", () => {
  it("matching sections receive the questions after the existing ones; new sections go at the end; duplicates are refused", async () => {
    const first = await createPaperFromImport(admin, details, parse(mcqCsv(3, "Section A")));
    calls = [];
    const csv2 = [mcqCsv(2, "section a").split("\n")[0], ...mcqCsv(5, "section a").split("\n").slice(4), ...mcqCsv(1, "Section B").split("\n").slice(1).map((l) => l.replace("Question 1:", "Question 99:"))].join("\n");
    const r = await saveImportToPaper(admin, first.paper.id, parse(csv2));
    expect(r).toEqual({ sectionsCreated: 1, questionsAdded: 3, groupsAdded: 0 });
    const sectionA = committed.sections.find((s) => s.title === "Section A")!;
    expect(committed.items.filter((i) => i.sectionId === sectionA.id).map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
    expect(committed.sections.find((s) => s.title === "Section B")).toMatchObject({ position: 2 });
    expect(calls.filter((c) => c.endsWith("createMany")).length).toBeLessThanOrEqual(5);

    // The same question again: refused before anything is written.
    await expect(saveImportToPaper(admin, first.paper.id, parse(mcqCsv(1, "Section A")))).rejects.toBeInstanceOf(ValidationError);
    expect(committed.questions).toHaveLength(6);
  });
});

describe("all-or-nothing, with clear errors", () => {
  it("duplicates (e.g. after editing the reviewed payload) are refused before any transaction starts", async () => {
    const payload = parse(mcqCsv(2));
    const [a, b] = payload.sections[0].items as { kind: "question"; question: { text: string } }[];
    b.question.text = a.question.text;
    await expect(createPaperFromImport(admin, details, payload)).rejects.toBeInstanceOf(ValidationError);
    expect(transactions).toBe(0);
    expect(committed.papers).toHaveLength(0);
  });

  it("a failure part-way leaves nothing behind — no paper, no questions", async () => {
    failOn = "paperQuestion.createMany";
    failWith = new Error("connection reset");
    await expect(createPaperFromImport(admin, details, parse(mcqCsv(50)))).rejects.toThrow("connection reset");
    expect(committed.papers).toHaveLength(0);
    expect(committed.questions).toHaveLength(0);
  });

  it("an expired transaction (P2028) becomes a clear message — no database internals", async () => {
    failOn = "question.createMany";
    failWith = new Prisma.PrismaClientKnownRequestError("Transaction API error: A query cannot be executed on an expired transaction. postgres://user:secret@host", { code: "P2028", clientVersion: "7.10.0" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = await createPaperFromImport(admin, details, parse(mcqCsv(50))).catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toMatch(/took too long.*nothing was saved/);
    expect(err.message).not.toMatch(/postgres|secret|P2028|transaction API/i);
    expect(committed.papers).toHaveLength(0);
  });

  it("an inactive or unknown course is a validation error (nothing saved)", async () => {
    committed.courses[0].isActive = false;
    await expect(createPaperFromImport(admin, details, parse(mcqCsv(2)))).rejects.toBeInstanceOf(ValidationError);
    await expect(createPaperFromImport(admin, { ...details, courseId: "nope" }, parse(mcqCsv(2)))).rejects.toBeInstanceOf(ValidationError);
    expect(committed.papers).toHaveLength(0);
  });
});
