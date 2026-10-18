import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import type { SessionUser } from "@/server/auth/session";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { createAssessment } from "@/server/services/assessments";
import { getQuestionPaper, listSelectablePapers } from "@/server/services/question-papers";
import { assessmentInput, createCourse, createUser, mcqSingle, resetDatabase, shortAnswer } from "./helpers";

/*
 * The Question Paper screens' server actions, end to end against assessment_test: session + role
 * check, the domain service, PostgreSQL, and the paths revalidated for the server pages.
 */

// --- Next.js request APIs: a cookie jar holding the signed-in user's session ----------------
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const actions = await import("@/server/actions/question-papers");

const users: Partial<Record<Role, SessionUser>> = {};
async function signInAs(role: Role) {
  if (!users[role]) {
    const u = await createUser({ role, name: `${role} user`, email: `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com` });
    users[role] = { id: u.id, email: u.email, name: u.name, role: u.role };
  }
  const { token } = await createSession(users[role]!.id);
  jar.set(SESSION_COOKIE_NAME, token);
  return users[role]!;
}

beforeEach(async () => {
  jar.clear();
  revalidatePath.mockClear();
  for (const k of Object.keys(users)) delete users[k as Role];
  await resetDatabase();
});
afterAll(() => db.$disconnect());

const ok = <T,>(r: { ok: boolean; data?: T; error?: string; fieldErrors?: unknown }) => {
  if (!r.ok) throw new Error(`action failed: ${r.error} ${JSON.stringify(r.fieldErrors ?? {})}`);
  return r.data as T;
};
const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof RedirectSignal ? e.url : Promise.reject(e)));
const fresh = async (paperId: string) => getQuestionPaper(users.ADMIN ?? (await signInAs(Role.ADMIN)), paperId);

const TEMPLATE = readFileSync(path.join(process.cwd(), "public/templates/question-paper-template.csv"), "utf8");
const csv = (rows: string[]) => ({
  fileName: "ai-final.csv",
  content: ["section,section_rule,section_count,group,group_text,type,question,option_a,option_b,option_c,correct,marks,negative_marks", ...rows].join("\n"),
});

async function newPaper(courseId: string, name = "AI for Leaders Final Exam") {
  return ok(await actions.createPaperAction({ name, courseId, subject: "AI Strategy", durationMinutes: "90", instructions: "Answer all questions." })).id;
}

/** A submittable paper built only through actions: Section A (2 MCQs), Section B (case + 2 parts). */
async function buildViaActions(paperId: string) {
  ok(await actions.addSectionAction(paperId, { title: "Section A — Objective" }));
  ok(await actions.addSectionAction(paperId, { title: "Section B — Case Study" }));
  const [a, b] = (await fresh(paperId)).sections;
  ok(await actions.addQuestionAction(paperId, a.id, mcqSingle({ text: "What is AI?" })));
  ok(await actions.addQuestionAction(paperId, a.id, mcqSingle({ text: "Which is supervised learning?", marks: 3 })));
  ok(await actions.addGroupAction(paperId, b.id, { groupType: "CASE_STUDY", text: "Read the case", passage: "An airline wants to cut delays…" }));
  const group = (await fresh(paperId)).sections[1].items[0];
  ok(await actions.addQuestionAction(paperId, b.id, shortAnswer({ text: "What is the core problem?" }), group.id));
  ok(await actions.addQuestionAction(paperId, b.id, shortAnswer({ text: "Propose an AI solution." }), group.id));
  return fresh(paperId);
}

// ---------------------------------------------------------------------------
describe("creating and editing a paper", () => {
  beforeEach(() => signInAs(Role.ADMIN));

  it("creates a DRAFT paper in PostgreSQL and refreshes the library", async () => {
    const course = await createCourse();
    const id = await newPaper(course.id);
    expect(await db.questionPaper.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: "AI for Leaders Final Exam",
      courseId: course.id,
      subject: "AI Strategy",
      durationMinutes: 90,
      status: "DRAFT",
      version: 1,
      sourceFileName: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/import-questions");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/import-questions/${id}/edit`);
    expect(await actions.createPaperAction({ name: "", courseId: course.id })).toMatchObject({ ok: false, fieldErrors: { name: expect.any(Array) } });
    expect(await actions.createPaperAction({ name: "Ghost", courseId: "missing" })).toMatchObject({ ok: false });
    expect(await db.questionPaper.count()).toBe(1);
  });

  it("persists paper details edits, and a fresh read returns them", async () => {
    const id = await newPaper((await createCourse()).id);
    ok(await actions.updatePaperAction(id, { name: "AI Final — 2026", description: "End-term", instructions: "No calculators.", durationMinutes: "120", subject: "" }));
    expect(await fresh(id)).toMatchObject({ name: "AI Final — 2026", description: "End-term", instructions: "No calculators.", durationMinutes: 120, subject: null });
  });

  it("adds, edits, reorders and removes sections", async () => {
    const id = await newPaper((await createCourse()).id);
    for (const title of ["Section A", "Section B", "Section C"]) ok(await actions.addSectionAction(id, { title }));
    const [a, b, c] = (await fresh(id)).sections;

    ok(await actions.updateSectionAction(id, b.id, { title: "Section B — Choose 2", instructions: "Any two.", isRequired: false, attemptRule: "ANY_N", attemptCount: "2" }));
    expect(await actions.updateSectionAction(id, b.id, { title: "Section B", attemptRule: "ANY_N" })).toMatchObject({ ok: false });
    ok(await actions.reorderSectionsAction(id, [c.id, a.id, b.id]));
    ok(await actions.removeSectionAction(id, a.id));

    const sections = (await fresh(id)).sections;
    expect(sections.map((s) => s.title)).toEqual(["Section C", "Section B — Choose 2"]);
    expect(sections[1]).toMatchObject({ instructions: "Any two.", isRequired: false, attemptRule: "ANY_N", attemptCount: 2 });
    expect(await db.paperSection.findMany({ where: { paperId: id }, orderBy: { position: "asc" }, select: { id: true } })).toEqual([{ id: c.id }, { id: b.id }]);
  });

  it("stores every question type with its options and correct answers", async () => {
    const id = await newPaper((await createCourse()).id);
    ok(await actions.addSectionAction(id, { title: "All types" }));
    const s = (await fresh(id)).sections[0];
    ok(await actions.addQuestionAction(id, s.id, mcqSingle({ text: "Single?" })));
    ok(
      await actions.addQuestionAction(id, s.id, {
        type: "MCQ_MULTI",
        text: "Multi?",
        difficulty: "HARD",
        marks: "3",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
          { text: "C", isCorrect: true },
        ],
      }),
    );
    ok(await actions.addQuestionAction(id, s.id, { type: "TRUE_FALSE", text: "Sky is blue.", marks: "1", difficulty: "EASY", options: [{ text: "True", isCorrect: true }, { text: "False", isCorrect: false }] }));
    ok(await actions.addQuestionAction(id, s.id, shortAnswer({ text: "Define AI.", guidance: "Mention learning from data." })));
    ok(await actions.addQuestionAction(id, s.id, { type: "LONG_ANSWER", text: "Discuss AI ethics.", marks: "10", difficulty: "MEDIUM" }));

    // Invalid questions are refused by the service's schema and never stored.
    expect(await actions.addQuestionAction(id, s.id, mcqSingle({ options: [{ text: "x", isCorrect: false }, { text: "y", isCorrect: false }] }))).toMatchObject({ ok: false });
    expect(await actions.addQuestionAction(id, s.id, { type: "SHORT_ANSWER", text: "", marks: "2", difficulty: "EASY" })).toMatchObject({ ok: false, fieldErrors: { text: expect.any(Array) } });

    const items = (await fresh(id)).sections[0].items;
    expect(items.map((i) => i.kind === "question" && i.question.type)).toEqual(["MCQ_SINGLE", "MCQ_MULTI", "TRUE_FALSE", "SHORT_ANSWER", "LONG_ANSWER"]);
    expect(items.map((i) => i.number)).toEqual(["1", "2", "3", "4", "5"]);

    const multi = await db.paperQuestion.findFirstOrThrow({ where: { paperId: id, position: 2 }, select: { question: { select: { options: { orderBy: { position: "asc" } } } } } });
    expect(multi.question!.options.map((o) => [o.position, o.text, o.isCorrect])).toEqual([
      [0, "A", true],
      [1, "B", false],
      [2, "C", true],
    ]);
    expect(await db.question.count()).toBe(5);
    expect(await db.questionOption.count()).toBe(3 + 3 + 2);
  });

  it("edits questions and case studies, reorders and deletes items", async () => {
    const id = await newPaper((await createCourse()).id);
    let paper = await buildViaActions(id);
    const [a, b] = paper.sections;
    const [q1, q2] = a.items;
    const group = b.items[0];
    if (group.kind !== "group") throw new Error("expected a group");

    ok(
      await actions.updateQuestionAction(id, q1.id, {
        type: "MCQ_SINGLE",
        text: "What does AI stand for?",
        difficulty: "EASY",
        marks: "4",
        negativeMarks: "1",
        options: [
          { text: "Artificial Intelligence", isCorrect: true },
          { text: "Automated Input", isCorrect: false },
        ],
      }),
    );
    ok(await actions.updateGroupAction(id, group.id, { groupType: "COMPREHENSION", text: "Read the passage", passage: "Updated passage." }));
    ok(await actions.reorderItemsAction(id, a.id, null, [q2.id, q1.id]));
    ok(await actions.reorderItemsAction(id, b.id, group.id, [group.children[1].id, group.children[0].id]));

    paper = await fresh(id);
    const [first, second] = paper.sections[0].items;
    expect(first).toMatchObject({ id: q2.id, number: "1" });
    expect(second).toMatchObject({ id: q1.id, number: "2", marks: 4, negativeMarks: 1, question: { text: "What does AI stand for?" } });
    if (second.kind !== "question") throw new Error("expected a question");
    expect(second.question.options.map((o) => o.text)).toEqual(["Artificial Intelligence", "Automated Input"]);
    expect(paper.sections[1].items[0]).toMatchObject({ groupType: "COMPREHENSION", text: "Read the passage", passage: "Updated passage." });
    const g = paper.sections[1].items[0];
    if (g.kind !== "group") throw new Error("expected a group");
    expect(g.children.map((c) => c.question.text)).toEqual(["Propose an AI solution.", "What is the core problem?"]);
    expect(g.children.map((c) => c.number)).toEqual(["3(a)", "3(b)"]);

    ok(await actions.removeItemAction(id, group.id));
    expect(await db.paperQuestion.count({ where: { paperId: id } })).toBe(2);
    expect((await fresh(id)).sections[1].items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("importing questions", () => {
  beforeEach(() => signInAs(Role.ADMIN));

  it("previews the template without writing anything", async () => {
    const preview = ok(await actions.previewImportAction({ fileName: "question-paper-template.csv", content: TEMPLATE }));
    expect(preview.issues).toEqual([]);
    expect(preview.summary.questions).toBeGreaterThan(0);
    expect(preview.sections.length).toBeGreaterThan(0);
    expect(await db.questionPaper.count()).toBe(0);
    expect(await db.question.count()).toBe(0);
  });

  it("creates a paper with its sections, questions and options from the template in one go", async () => {
    const course = await createCourse();
    const preview = ok(await actions.previewImportAction({ fileName: "question-paper-template.csv", content: TEMPLATE }));
    const { id, questionsAdded } = ok(await actions.createPaperFromImportAction({ name: "Imported paper", courseId: course.id }, { fileName: "question-paper-template.csv", content: TEMPLATE }));

    expect(questionsAdded).toBe(preview.summary.questions);
    const paper = await fresh(id);
    expect(paper).toMatchObject({ status: "DRAFT", sourceFileName: "question-paper-template.csv", questionCount: preview.summary.questions });
    expect(paper.sections.map((s) => s.title)).toEqual(preview.sections.map((s) => s.title));
    expect(await db.question.count()).toBe(preview.summary.questions);
    expect(await db.questionOption.count()).toBeGreaterThan(0);
  });

  it("rejects a file with invalid rows: nothing is created", async () => {
    const course = await createCourse();
    const bad = csv(["Section A,ALL,,,,MCQ_SINGLE,What is AI?,A,B,C,Z,2,0", "Section A,ALL,,,,SHORT_ANSWER,,,,,,5,0", "Section A,ALL,,,,MCQ_SINGLE,Valid?,A,B,C,A,2,0"]);

    const preview = ok(await actions.previewImportAction(bad));
    expect(preview.issues.length).toBeGreaterThanOrEqual(2);

    const result = await actions.createPaperFromImportAction({ name: "Bad import", courseId: course.id }, bad);
    expect(result).toMatchObject({ ok: false, fieldErrors: { rows: expect.arrayContaining([expect.stringMatching(/^Row 2/), expect.stringMatching(/^Row 3/)]) } });
    expect(await db.questionPaper.count()).toBe(0);
    expect(await db.question.count()).toBe(0);
    expect(await db.paperQuestion.count()).toBe(0);
  });

  it("imports more questions into a draft, all or nothing", async () => {
    const id = await newPaper((await createCourse()).id);
    ok(await actions.addSectionAction(id, { title: "Section A" }));

    expect(await actions.importIntoPaperAction(id, csv(["Section A,ALL,,,,MCQ_SINGLE,Good,A,B,C,A,2,0", "Section A,ALL,,,,MCQ_SINGLE,Bad,A,B,C,,2,0"]))).toMatchObject({ ok: false });
    expect(await db.paperQuestion.count({ where: { paperId: id } })).toBe(0);

    const r = ok(await actions.importIntoPaperAction(id, csv(["Section A,ALL,,,,MCQ_SINGLE,Good,A,B,C,A,2,0", "Section B,ALL,,,,LONG_ANSWER,Essay,,,,,10,0"])));
    expect(r).toMatchObject({ questionsAdded: 2, sectionsCreated: 1 });
    const paper = await fresh(id);
    expect(paper.sections.map((s) => [s.title, s.items.length])).toEqual([
      ["Section A", 1],
      ["Section B", 1],
    ]);
    expect(await actions.previewImportAction({ fileName: "paper.xlsx", content: "" })).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
describe("saved papers are usable at once", () => {
  it("1/2/3/4/5/7: build and save through the actions → offered to the Assessment Builder straight away, no review or proctor", async () => {
    const admin = await signInAs(Role.ADMIN);
    const course = await createCourse();
    const id = await newPaper(course.id);
    // Saved but empty: not offered yet.
    expect(await listSelectablePapers(admin)).toEqual([]);
    await buildViaActions(id);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/assessments/new");
    expect((await listSelectablePapers(admin)).map((p) => p.id)).toEqual([id]);
    expect(await fresh(id)).toMatchObject({ issues: [], inUse: false });
    // …and an assessment can select it.
    const a = await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: id }));
    expect(await db.assessmentQuestion.count({ where: { assessmentId: a.id } })).toBeGreaterThan(0);
    // No reviewer ever existed, and the paper never went through a status change.
    expect(await db.user.count({ where: { role: Role.REVIEWER } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "question_paper.status_changed" } })).toBe(0);
  });

  it("6: a paper stays editable through the actions until an assessment uses it", async () => {
    const admin = await signInAs(Role.ADMIN);
    const course = await createCourse();
    const id = await newPaper(course.id);
    const built = await buildViaActions(id);
    ok(await actions.updatePaperAction(id, { name: "Renamed after saving" }));
    ok(await actions.addSectionAction(id, { title: "Late section" }));
    ok(await actions.removeSectionAction(id, (await fresh(id)).sections.at(-1)!.id));

    await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: id }));
    expect(await actions.updatePaperAction(id, { name: "Changed while in use" })).toMatchObject({ ok: false, error: expect.stringMatching(/used by an assessment/) });
    expect(await actions.addSectionAction(id, { title: "Another" })).toMatchObject({ ok: false });
    expect(await actions.removeItemAction(id, built.sections[0].items[0].id)).toMatchObject({ ok: false });
  });

  it("a new version of a paper in use is a separate, editable copy; the one in use stays as it is", async () => {
    const admin = await signInAs(Role.ADMIN);
    const course = await createCourse();
    const v1 = await newPaper(course.id);
    const built = await buildViaActions(v1);
    // Not in use yet: edit directly instead of versioning.
    expect(await actions.createRevisionAction(v1)).toMatchObject({ ok: false });
    await createAssessment(admin, assessmentInput(course.id, { type: "MIXED", paperId: v1 }));

    const before = await fresh(v1);
    const { id: v2, version } = ok(await actions.createRevisionAction(v1));
    expect(version).toBe(2);
    expect(await actions.createRevisionAction(v1)).toMatchObject({ ok: false });

    const copy = await fresh(v2);
    expect(copy).toMatchObject({ version: 2, inUse: false, basedOn: { id: v1, version: 1 }, questionCount: before.questionCount, totalMarks: before.totalMarks });
    ok(await actions.updateQuestionAction(v2, copy.sections[0].items[0].id, mcqSingle({ text: "Rewritten for v2", marks: 5 })));
    ok(await actions.updatePaperAction(v2, { name: "AI for Leaders Final Exam v2" }));

    const after = await fresh(v1);
    expect(after).toEqual(before);
    const first = after.sections[0].items[0];
    expect(first.kind === "question" && first.question.text).toBe(built.sections[0].items[0].kind === "question" ? built.sections[0].items[0].question.text : "");
    expect((await fresh(v2)).sections[0].items[0]).toMatchObject({ marks: 5, question: { text: "Rewritten for v2" } });
  });
});

// ---------------------------------------------------------------------------
describe("access control", () => {
  it("only admins build papers; proctors have no part in them", async () => {
    const course = await createCourse();
    await signInAs(Role.ADMIN);
    const id = await newPaper(course.id);
    await buildViaActions(id);
    const file = { fileName: "q.csv", content: TEMPLATE };

    for (const role of [Role.REVIEWER, Role.EXAMINER]) {
      await signInAs(role);
      for (const call of [
        actions.createPaperAction({ name: "x", courseId: course.id }),
        actions.updatePaperAction(id, { name: "x" }),
        actions.addSectionAction(id, { title: "x" }),
        actions.previewImportAction(file),
        actions.createPaperFromImportAction({ name: "x", courseId: course.id }, file),
        actions.createRevisionAction(id),
      ]) {
        expect(await redirectOf(call)).toBe("/forbidden");
      }
    }

    // Learners have no staff session (an exam credential is required), so they are sent to log in.
    await signInAs(Role.LEARNER);
    expect(await redirectOf(actions.createPaperAction({ name: "x", courseId: course.id }))).toBe("/login");
    jar.clear();
    expect(await redirectOf(actions.updatePaperAction(id, { name: "x" }))).toBe("/login");

    expect(await db.questionPaper.count()).toBe(1);
    expect(await db.questionPaper.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "AI for Leaders Final Exam" });
  });
});
