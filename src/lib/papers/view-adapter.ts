import type { QuestionPaperDetail } from "@/server/services/question-papers";
import type { AttemptRuleKind, Question, QuestionPaper, ResponseConfig, SupportingMaterial } from "@/prototype/types";

type DetailMaterial = QuestionPaperDetail["sections"][number]["items"][number]["materials"][number];
type DetailResponse = Extract<QuestionPaperDetail["sections"][number]["items"][number], { kind: "question" }>["response"];

/** Real stored materials in the shape the read-only components render (id = the stored file id). */
const materialsOf = (list: DetailMaterial[]): SupportingMaterial[] =>
  list.map((m) => ({ id: m.file.id, name: m.file.fileName, ext: m.file.extension, sizeKb: m.file.sizeBytes / 1024, description: m.description ?? undefined, kind: ["png", "jpg", "jpeg", "svg"].includes(m.file.extension) ? "image" : ["xls", "xlsx", "csv"].includes(m.file.extension) ? "dataset" : "document" }));

const responseOf = (r: DetailResponse): ResponseConfig => ({
  type: r.type === "FILE" ? "file" : r.type === "TEXT_FILE" ? "text_file" : "text",
  allowedTypes: r.allowedFileTypes,
  maxSizeMb: r.maxFileSizeMb,
  maxFiles: r.maxFiles,
  allowReplace: true,
  fileRequired: r.fileRequired,
});

/*
 * Maps a question paper loaded from PostgreSQL to the shape the existing read-only paper
 * components (QuestionView, PaperStructure, PaperStats) render. Display only — nothing here is
 * stored or edited; the database stays authoritative.
 */

type Detail = Pick<QuestionPaperDetail, "id" | "name" | "description" | "subject" | "durationMinutes" | "version" | "sourceFileName" | "createdAt" | "sections" | "course">;

function ruleKind(s: { isRequired: boolean; attemptRule: string }): AttemptRuleKind {
  if (s.attemptRule === "ALL") return s.isRequired ? "COMPULSORY" : "OPTIONAL";
  return s.attemptRule as AttemptRuleKind;
}

export function toViewPaper(p: Detail): QuestionPaper {
  const questions: Question[] = [];
  const sections = p.sections.map((s) => {
    const numbers: string[] = [];
    for (const item of s.items) {
      numbers.push(item.number);
      const base = { sectionId: s.id, compulsory: s.isRequired, needsReview: false };
      if (item.kind === "question") {
        questions.push({
          ...base,
          id: item.id,
          number: item.number,
          type: item.question.type,
          text: item.question.text,
          options: item.question.options.map((o) => ({ id: o.id, text: o.text, correct: o.isCorrect })),
          marks: item.marks,
          materials: materialsOf(item.materials),
          response: responseOf(item.response),
          children: [],
        });
      } else {
        questions.push({
          ...base,
          id: item.id,
          number: item.number,
          type: item.groupType,
          text: item.text,
          passage: item.passage ?? undefined,
          options: [],
          marks: item.marks,
          materials: materialsOf(item.materials),
          children: item.children.map((c) => ({
            ...base,
            id: c.id,
            number: c.number,
            type: c.question.type,
            text: c.question.text,
            options: c.question.options.map((o) => ({ id: o.id, text: o.text, correct: o.isCorrect })),
            marks: c.marks,
            materials: materialsOf(c.materials),
            response: responseOf(c.response),
            children: [],
          })),
        });
      }
    }
    return {
      id: s.id,
      name: s.title,
      range: numbers.length ? (numbers.length === 1 ? `Q${numbers[0]}` : `Q${numbers[0]}–Q${numbers[numbers.length - 1]}`) : "—",
      rule: ruleKind(s),
      ruleCount: s.attemptCount ?? undefined,
      marks: s.maxMarks,
    };
  });
  return {
    id: p.id,
    name: p.name,
    courseId: p.course.id,
    subject: p.subject ?? "",
    batchId: "",
    description: p.description ?? "",
    version: `v${p.version}`,
    // Papers have no review status any more; the prototype display type still has the field.
    status: "Draft",
    source: p.sourceFileName ? "Excel" : "Manual",
    fileName: p.sourceFileName ?? undefined,
    importedOn: p.createdAt.toISOString(),
    durationMinutes: p.durationMinutes ?? 0,
    sections,
    questions,
  };
}
