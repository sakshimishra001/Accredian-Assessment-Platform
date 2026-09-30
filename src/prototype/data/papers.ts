import { at } from "../lib/random";
import type { ImportSource, PaperStatus, Question, QuestionPaper, QuestionType, Section } from "../types";
import { POOLS, type McqSpec } from "./pools";

type Template = "midterm" | "final" | "quiz" | "case" | "analytics";

let seq = 0;
const qid = (paperId: string) => `${paperId}-q${++seq}`;

function mcqQuestion(paperId: string, number: string, sectionId: string, spec: McqSpec, type: QuestionType, marks: number): Question {
  return {
    id: qid(paperId),
    number,
    type,
    text: spec.text,
    options: spec.options.map((text, i) => ({ id: `${paperId}-o${seq}-${i}`, text, correct: spec.correct.includes(i) })),
    marks,
    sectionId,
    compulsory: true,
    needsReview: false,
    children: [],
  };
}

function textQuestion(paperId: string, number: string, sectionId: string, text: string, type: QuestionType, marks: number): Question {
  return { id: qid(paperId), number, type, text, options: [], marks, sectionId, compulsory: true, needsReview: false, children: [] };
}

function tfQuestion(paperId: string, number: string, sectionId: string, text: string, answer: boolean, marks: number): Question {
  return mcqQuestion(paperId, number, sectionId, { text, options: ["True", "False"], correct: [answer ? 0 : 1] }, "TRUE_FALSE", marks);
}

const cycle = <T,>(list: T[], i: number) => list[i % list.length];
const sub = (n: number) => String.fromCharCode(97 + n); // a, b, c…

function build(paperId: string, courseId: string, template: Template, flagged: boolean): { sections: Section[]; questions: Question[] } {
  const pool = POOLS[courseId];
  const qs: Question[] = [];

  if (template === "midterm") {
    const sections: Section[] = [
      { id: `${paperId}-sA`, name: "Section A — Case Study & Long Answer", range: "Q1–Q2", rule: "COMPULSORY", marks: 20 },
      { id: `${paperId}-sB`, name: "Section B — Multiple Choice", range: "Q3–Q17", rule: "COMPULSORY", marks: 15 },
      { id: `${paperId}-sC`, name: "Section C — Multiple Response", range: "Q18–Q25", rule: "ANY_N", ruleCount: 5, marks: 15 },
      { id: `${paperId}-sD`, name: "Section D — Concepts & Comprehension", range: "Q26–Q32", rule: "BEST_N", ruleCount: 5, marks: 20 },
    ];
    const [a, b, c, d] = sections.map((s) => s.id);
    const cs = textQuestion(paperId, "1", a, `Read the case "${pool.caseStudy.title}" and answer the questions that follow.`, "CASE_STUDY", 10);
    cs.passage = pool.caseStudy.passage;
    cs.children = pool.caseStudy.parts.slice(0, 3).map((t, i) => textQuestion(paperId, `1(${sub(i)})`, a, t, "SHORT_ANSWER", [4, 3, 3][i]));
    qs.push(cs, textQuestion(paperId, "2", a, pool.long[0], "LONG_ANSWER", 10));
    for (let i = 0; i < 15; i++) qs.push(mcqQuestion(paperId, String(3 + i), b, cycle(pool.mcq, i), "MCQ_SINGLE", 1));
    for (let i = 0; i < 8; i++) {
      const q = mcqQuestion(paperId, String(18 + i), c, cycle(pool.multi, i), "MCQ_MULTI", 3);
      q.compulsory = false;
      qs.push(q);
    }
    const comp = textQuestion(paperId, "26", d, "Read the passage and answer the questions that follow.", "COMPREHENSION", 4);
    comp.passage = pool.comprehension.passage;
    comp.compulsory = false;
    comp.children = pool.comprehension.parts.map((p, i) => ({ ...mcqQuestion(paperId, `26(${sub(i)})`, d, p, "MCQ_SINGLE", i === 0 ? 2 : 1), compulsory: false }));
    qs.push(comp);
    for (let i = 0; i < 6; i++) {
      const n = String(27 + i);
      const q =
        i % 2 === 0
          ? tfQuestion(paperId, n, d, cycle(pool.trueFalse, i).text, cycle(pool.trueFalse, i).answer, 4)
          : mcqQuestion(paperId, n, d, cycle(pool.mcq, i + 7), "MCQ_SINGLE", 4);
      q.compulsory = false;
      qs.push(q);
    }
    if (courseId === "c-pm") {
      // Data-interpretation question with admin-attached supporting material.
      const q7 = qs.find((q) => q.number === "7")!;
      q7.text = "Analyze the following market data and answer the question: which region should the product launch in first?";
      q7.options = ["North", "South", "West", "East"].map((text, i) => ({ id: `${paperId}-o7-${i}`, text, correct: i === 2 }));
      q7.materials = [
        { id: `${paperId}-m1`, name: "market-data.pdf", kind: "document", ext: "pdf", sizeKb: 412, description: "Regional market overview" },
        { id: `${paperId}-m2`, name: "regional-sales.csv", kind: "dataset", ext: "csv", sizeKb: 18, description: "Quarterly sales by region" },
      ];
      cs.materials = [{ id: `${paperId}-m3`, name: "Market Share.png", kind: "image", ext: "png", sizeKb: 236 }];
    }
    if (flagged) {
      const q7 = qs.find((q) => q.number === "7")!;
      q7.options = q7.options.map((o) => ({ ...o, correct: false }));
      q7.needsReview = true;
      q7.reviewNote = "Correct answer could not be detected in the source file.";
      const q19 = qs.find((q) => q.number === "19")!;
      q19.marks = 0;
      q19.needsReview = true;
      q19.reviewNote = "Marks were not found next to this question.";
      const q28 = qs.find((q) => q.number === "28")!;
      q28.options = q28.options.map((o, i) => (i === 2 ? { ...o, text: "" } : o));
      q28.needsReview = true;
      q28.reviewNote = "Option C text was unreadable (possible scan artefact).";
    }
    return { sections, questions: qs };
  }

  if (template === "analytics") {
    // Demonstrates the file workflow: admin resource → learner downloads → works on it → uploads the completed file.
    const sections: Section[] = [
      { id: `${paperId}-sA`, name: "Section A — Concepts", range: "Q1–Q6", rule: "COMPULSORY", marks: 6 },
      { id: `${paperId}-sB`, name: "Section B — Data Analysis", range: "Q7–Q9", rule: "COMPULSORY", marks: 24 },
    ];
    const [a, b] = sections.map((s) => s.id);
    for (let i = 0; i < 6; i++) qs.push(mcqQuestion(paperId, String(1 + i), a, cycle(pool.mcq, i), "MCQ_SINGLE", 1));
    const q7 = textQuestion(paperId, "7", b, "Analyze the sales data and calculate the requested metrics: revenue per unit for each product and each product’s share of total revenue.", "LONG_ANSWER", 10);
    q7.instructions = "Download the CSV file below, complete your analysis using the same file, and upload the completed CSV file as your answer.";
    q7.materials = [
      { id: `${paperId}-m1`, name: "sales-data.csv", kind: "dataset", ext: "csv", sizeKb: 4, description: "Dataset provided for this question." },
      { id: `${paperId}-m2`, name: "instructions.pdf", kind: "document", ext: "pdf", sizeKb: 96, description: "Step-by-step task instructions." },
      { id: `${paperId}-m3`, name: "market-chart.png", kind: "image", ext: "png", sizeKb: 148, description: "Market share reference chart." },
    ];
    q7.response = { type: "file", allowedTypes: ["csv", "xlsx"], maxSizeMb: 20, maxFiles: 1, allowReplace: true, fileRequired: true };
    const q8 = textQuestion(paperId, "8", b, "In two or three sentences, explain which product line you would prioritise next quarter and why.", "SHORT_ANSWER", 4);
    const q9 = textQuestion(paperId, "9", b, "Write a short recommendation for leadership based on your analysis, and attach the supporting document you prepared (slides, report or workbook).", "LONG_ANSWER", 10);
    q9.instructions = "Write your recommendation below and attach one supporting document.";
    q9.materials = [{ id: `${paperId}-m4`, name: "recommendation-template.docx", kind: "document", ext: "docx", sizeKb: 38, description: "Optional template for your report." }];
    q9.response = { type: "text_file", allowedTypes: ["pdf", "docx", "xlsx", "pptx"], maxSizeMb: 20, maxFiles: 1, allowReplace: true, fileRequired: true };
    qs.push(q7, q8, q9);
    return { sections, questions: qs };
  }

  if (template === "final") {
    const sections: Section[] = [
      { id: `${paperId}-sA`, name: "Section A — Compulsory", range: "Q1–Q2", rule: "COMPULSORY", marks: 20 },
      { id: `${paperId}-sB`, name: "Section B — Short Answer", range: "Q3–Q10", rule: "ANY_N", ruleCount: 5, marks: 10 },
      { id: `${paperId}-sC`, name: "Section C — Long Answer", range: "Q11–Q15", rule: "ANY_N", ruleCount: 3, marks: 30 },
    ];
    const [a, b, c] = sections.map((s) => s.id);
    qs.push(textQuestion(paperId, "1", a, pool.long[0], "LONG_ANSWER", 10));
    const q2 = textQuestion(paperId, "2", a, `Answer all parts of the following question on ${pool.subject}.`, "LONG_ANSWER", 10);
    q2.children = pool.short.slice(0, 3).map((t, i) => textQuestion(paperId, `2(${sub(i)})`, a, t, "SHORT_ANSWER", [4, 3, 3][i]));
    qs.push(q2);
    for (let i = 0; i < 8; i++) qs.push({ ...textQuestion(paperId, String(3 + i), b, cycle(pool.short, i), "SHORT_ANSWER", 2), compulsory: false });
    for (let i = 0; i < 5; i++) {
      if (i === 0) {
        const cs = textQuestion(paperId, "11", c, `Case: ${pool.caseStudy.title}`, "CASE_STUDY", 10);
        cs.passage = pool.caseStudy.passage;
        cs.compulsory = false;
        cs.children = pool.caseStudy.parts.slice(0, 2).map((t, j) => ({ ...textQuestion(paperId, `11(${sub(j)})`, c, t, "SHORT_ANSWER", 5), compulsory: false }));
        qs.push(cs);
      } else qs.push({ ...textQuestion(paperId, String(11 + i), c, cycle(pool.long, i), "LONG_ANSWER", 10), compulsory: false });
    }
    return { sections, questions: qs };
  }

  if (template === "quiz") {
    const s: Section = { id: `${paperId}-sA`, name: "Section A — Objective", range: "Q1–Q20", rule: "COMPULSORY", marks: 20 };
    for (let i = 0; i < 20; i++) {
      const n = String(i + 1);
      qs.push(
        i % 5 === 4
          ? tfQuestion(paperId, n, s.id, cycle(pool.trueFalse, i).text, cycle(pool.trueFalse, i).answer, 1)
          : i % 5 === 3
            ? mcqQuestion(paperId, n, s.id, cycle(pool.multi, i), "MCQ_MULTI", 1)
            : mcqQuestion(paperId, n, s.id, cycle(pool.mcq, i), "MCQ_SINGLE", 1),
      );
    }
    if (flagged) {
      qs[5].needsReview = true;
      qs[5].options = qs[5].options.map((o) => ({ ...o, correct: false }));
      qs[5].reviewNote = "Correct answer could not be detected.";
    }
    return { sections: [s], questions: qs };
  }

  // case
  const sections: Section[] = [
    { id: `${paperId}-sA`, name: "Section A — Case Analysis", range: "Q1", rule: "COMPULSORY", marks: 25 },
    { id: `${paperId}-sB`, name: "Section B — Short Answer", range: "Q2–Q6", rule: "ANY_N", ruleCount: 3, marks: 15 },
  ];
  const cs = textQuestion(paperId, "1", sections[0].id, `Case: ${pool.caseStudy.title}`, "CASE_STUDY", 25);
  cs.passage = pool.caseStudy.passage;
  cs.children = pool.caseStudy.parts.map((t, i) => textQuestion(paperId, `1(${sub(i)})`, sections[0].id, t, "SHORT_ANSWER", 5));
  qs.push(cs);
  for (let i = 0; i < 5; i++) qs.push({ ...textQuestion(paperId, String(2 + i), sections[1].id, cycle(pool.short, i), "SHORT_ANSWER", 5), compulsory: false });
  return { sections, questions: qs };
}

const DURATION: Record<Template, number> = { midterm: 90, final: 120, quiz: 30, case: 90, analytics: 60 };

interface PaperSpec {
  id: string;
  name: string;
  courseId: string;
  batchId: string;
  template: Template;
  status: PaperStatus;
  source: ImportSource;
  daysAgo: number;
  version?: string;
}

const SPECS: PaperSpec[] = [
  { id: "p-pm01-mt1", name: "PM-01 – Mid Term 1", courseId: "c-pm", batchId: "b-pm01", template: "midterm", status: "Approved", source: "Excel", daysAgo: 21 },
  { id: "p-pm01-final", name: "PM-01 – Final Assessment", courseId: "c-pm", batchId: "b-pm01", template: "final", status: "Approved", source: "Word", daysAgo: 12 },
  { id: "p-spm01-case", name: "SPM-01 – Strategic Project Case", courseId: "c-spm", batchId: "b-spm01", template: "case", status: "Approved", source: "PDF", daysAgo: 16 },
  { id: "p-ds01-quiz", name: "DS-01 – Data Science Quiz", courseId: "c-ds", batchId: "b-ds01", template: "quiz", status: "Approved", source: "Excel", daysAgo: 30 },
  { id: "p-pm02-mt1", name: "PM-02 – Mid Term 1", courseId: "c-pm", batchId: "b-pm02", template: "midterm", status: "Approved", source: "Excel", daysAgo: 9 },
  { id: "p-ds01-final", name: "DS-01 – Final Assessment", courseId: "c-ds", batchId: "b-ds01", template: "final", status: "Approved", source: "Word", daysAgo: 6 },
  { id: "p-spm01-quiz2", name: "SPM-01 – Quiz 2", courseId: "c-spm", batchId: "b-spm01", template: "quiz", status: "Approved", source: "Excel", daysAgo: 8 },
  { id: "p-gai01-quiz", name: "GAI-01 – Prompt Engineering Quiz", courseId: "c-gai", batchId: "b-gai01", template: "quiz", status: "Needs Review", source: "PDF", daysAgo: 2 },
  { id: "p-pm02-quiz1", name: "PM-02 – Quiz 1", courseId: "c-pm", batchId: "b-pm02", template: "quiz", status: "Draft", source: "Manual", daysAgo: 1 },
  { id: "p-ds02-diag", name: "DS-02 – Diagnostic Quiz", courseId: "c-ds", batchId: "b-ds02", template: "quiz", status: "Processing", source: "PDF", daysAgo: 0 },
  { id: "p-ail01-final", name: "AIL-01 – Final Assessment", courseId: "c-ail", batchId: "b-ail01", template: "final", status: "Archived", source: "Word", daysAgo: 160 },
  { id: "p-ail01-case", name: "AIL-01 – Leadership Case", courseId: "c-ail", batchId: "b-ail01", template: "case", status: "Archived", source: "PDF", daysAgo: 190 },
  { id: "p-pm01-quiz1", name: "PM-01 – Quiz 1", courseId: "c-pm", batchId: "b-pm01", template: "quiz", status: "Approved", source: "Excel", daysAgo: 60 },
  { id: "p-pm01-quiz2", name: "PM-01 – Quiz 2", courseId: "c-pm", batchId: "b-pm01", template: "quiz", status: "Approved", source: "Excel", daysAgo: 40 },
  { id: "p-pm02-case", name: "PM-02 – Product Case Study", courseId: "c-pm", batchId: "b-pm02", template: "case", status: "Needs Review", source: "Word", daysAgo: 3 },
  { id: "p-spm01-mt", name: "SPM-01 – Mid Term", courseId: "c-spm", batchId: "b-spm01", template: "midterm", status: "Approved", source: "Excel", daysAgo: 35 },
  { id: "p-spm01-final", name: "SPM-01 – Final Assessment", courseId: "c-spm", batchId: "b-spm01", template: "final", status: "Draft", source: "Manual", daysAgo: 4 },
  { id: "p-ds01-mt", name: "DS-01 – Mid Term", courseId: "c-ds", batchId: "b-ds01", template: "midterm", status: "Approved", source: "Excel", daysAgo: 75 },
  { id: "p-ds01-case", name: "DS-01 – Capstone Case", courseId: "c-ds", batchId: "b-ds01", template: "case", status: "Approved", source: "PDF", daysAgo: 18 },
  { id: "p-ds02-quiz1", name: "DS-02 – Quiz 1", courseId: "c-ds", batchId: "b-ds02", template: "quiz", status: "Draft", source: "Excel", daysAgo: 2 },
  { id: "p-gai01-mt", name: "GAI-01 – Mid Term", courseId: "c-gai", batchId: "b-gai01", template: "midterm", status: "Approved", source: "Word", daysAgo: 14 },
  { id: "p-gai01-case", name: "GAI-01 – RAG Design Case", courseId: "c-gai", batchId: "b-gai01", template: "case", status: "Approved", source: "PDF", daysAgo: 10 },
  { id: "p-gai01-final", name: "GAI-01 – Final Assessment", courseId: "c-gai", batchId: "b-gai01", template: "final", status: "Draft", source: "Manual", daysAgo: 1 },
  { id: "p-ail01-quiz", name: "AIL-01 – Quiz 1", courseId: "c-ail", batchId: "b-ail01", template: "quiz", status: "Archived", source: "Excel", daysAgo: 220 },
  { id: "p-ail01-mt", name: "AIL-01 – Mid Term", courseId: "c-ail", batchId: "b-ail01", template: "midterm", status: "Archived", source: "Excel", daysAgo: 200 },
  { id: "p-pm01-analytics", name: "PM-01 – Sales Analytics Assessment", courseId: "c-pm", batchId: "b-pm01", template: "analytics", status: "Approved", source: "Manual", daysAgo: 3 },
  { id: "p-pm01-retest", name: "PM-01 – Mid Term 1 (Re-test)", courseId: "c-pm", batchId: "b-pm01", template: "midterm", status: "Approved", source: "Excel", daysAgo: 5, version: "v1.1" },
  { id: "p-spm01-quiz1", name: "SPM-01 – Quiz 1", courseId: "c-spm", batchId: "b-spm01", template: "quiz", status: "Approved", source: "Excel", daysAgo: 50 },
  { id: "p-ds01-quiz2", name: "DS-01 – SQL Quiz", courseId: "c-ds", batchId: "b-ds01", template: "quiz", status: "Needs Review", source: "PDF", daysAgo: 1 },
];

const EXT: Record<ImportSource, string> = { Excel: "xlsx", Word: "docx", PDF: "pdf", Manual: "" };

export function buildPaper(spec: PaperSpec): QuestionPaper {
  const flagged = spec.status === "Needs Review" || spec.status === "Processing";
  const { sections, questions } = build(spec.id, spec.courseId, spec.template, flagged);
  return {
    id: spec.id,
    name: spec.name,
    courseId: spec.courseId,
    subject: POOLS[spec.courseId].subject,
    batchId: spec.batchId,
    description: `${spec.template === "quiz" ? "Objective quiz" : spec.template === "case" ? "Case-based assessment" : spec.template === "analytics" ? "Hands-on data analysis with file answers" : "Sectioned examination"} for ${spec.name.split(" – ")[0]}.`,
    version: spec.version ?? "v1.0",
    status: spec.status,
    source: spec.source,
    fileName: spec.source === "Manual" ? undefined : `${spec.name.replace(/[–\s]+/g, "_")}.${EXT[spec.source]}`,
    importedOn: at(-spec.daysAgo, 11, 30),
    durationMinutes: DURATION[spec.template],
    sections,
    questions,
  };
}

export const questionPapers: QuestionPaper[] = SPECS.map(buildPaper);

/**
 * The paper produced by the simulated import. Same structure as a mid-term with three
 * questions flagged for review, matching what the parser "detected".
 */
export function simulatedImportPaper(id: string, fileName: string, source: ImportSource): QuestionPaper {
  const paper = buildPaper({
    id,
    name: "Batch 1 – Product Management – Mid Term 1",
    courseId: "c-pm",
    batchId: "b-pm01",
    template: "midterm",
    status: "Needs Review",
    source,
    daysAgo: 0,
  });
  return { ...paper, fileName, importedOn: new Date().toISOString(), description: "Imported mid-term examination for PM-01." };
}
