import { at, seeded } from "../lib/random";
import { flatten, isObjectiveType, paperTotals } from "../lib/paper";
import type { AppNotification, Assessment, AssessmentSettings, Evaluation, ResultRow } from "../types";
import { batches } from "./org";
import { questionPapers } from "./papers";

const defaults: AssessmentSettings = {
  timingMode: "window",
  randomizeQuestions: false,
  randomizeOptions: true,
  showResultsImmediately: false,
  resultVisibility: "score",
  allowResume: true,
  showQuestionPalette: true,
  allowMarkForReview: true,
  proctoring: false,
};

interface Spec {
  id: string;
  name: string;
  batchId: string;
  paperId: string | null;
  type: Assessment["type"];
  status: Assessment["status"];
  startDay: number;
  startHour?: number;
  endHour?: number;
  examinerIds?: string[];
  settings?: Partial<AssessmentSettings>;
  negativeMarking?: boolean;
}

const SPECS: Spec[] = [
  { id: "a-pm01-mt1", name: "Product Management – Mid Term 1", batchId: "b-pm01", paperId: "p-pm01-mt1", type: "Mixed", status: "Scheduled", startDay: 2, examinerIds: ["e-priya", "e-rahul"], negativeMarking: true },
  { id: "a-spm01-quiz2", name: "Strategic Project Management – Quiz 2", batchId: "b-spm01", paperId: "p-spm01-quiz2", type: "Objective", status: "Active", startDay: 0, startHour: 9, endHour: 20 },
  { id: "a-ds01-final", name: "Data Science – Final Assessment", batchId: "b-ds01", paperId: "p-ds01-final", type: "Subjective", status: "Scheduled", startDay: 6, examinerIds: ["e-sameer", "e-anjali"] },
  { id: "a-pm02-mt1", name: "Product Management – Mid Term 1 (PM-02)", batchId: "b-pm02", paperId: "p-pm02-mt1", type: "Mixed", status: "Scheduled", startDay: 4, examinerIds: ["e-rahul"], negativeMarking: true },
  { id: "a-gai01-mt", name: "Generative AI – Mid Term", batchId: "b-gai01", paperId: "p-gai01-mt", type: "Mixed", status: "Active", startDay: 0, startHour: 10, endHour: 19, examinerIds: ["e-vikram"], settings: { proctoring: true } },
  { id: "a-pm01-analytics", name: "Product Management – Sales Analytics Assessment", batchId: "b-pm01", paperId: "p-pm01-analytics", type: "Mixed", status: "Active", startDay: 0, startHour: 8, endHour: 22, examinerIds: ["e-priya"] },
  { id: "a-pm01-quiz2", name: "Product Management – Quiz 2", batchId: "b-pm01", paperId: "p-pm01-quiz2", type: "Objective", status: "Published", startDay: -10, settings: { showResultsImmediately: true } },
  { id: "a-spm01-mt", name: "Strategic Project Management – Mid Term", batchId: "b-spm01", paperId: "p-spm01-mt", type: "Mixed", status: "Evaluation", startDay: -4, examinerIds: ["e-priya", "e-kavita"], negativeMarking: true },
  { id: "a-ds01-case", name: "Data Science – Capstone Case", batchId: "b-ds01", paperId: "p-ds01-case", type: "Subjective", status: "Completed", startDay: -2, examinerIds: ["e-sameer"] },
  { id: "a-gai01-case", name: "Generative AI – RAG Design Case", batchId: "b-gai01", paperId: "p-gai01-case", type: "Subjective", status: "Scheduled", startDay: 9, examinerIds: ["e-anjali"] },
  { id: "a-spm01-quiz1", name: "Strategic Project Management – Quiz 1 (Re-test)", batchId: "b-spm01", paperId: "p-spm01-quiz1", type: "Objective", status: "Scheduled", startDay: 12 },
  { id: "a-pm02-quiz1", name: "Product Management – Quiz 1 (PM-02)", batchId: "b-pm02", paperId: null, type: "Objective", status: "Draft", startDay: 15 },
];

export const assessments: Assessment[] = SPECS.map((s, i) => {
  const paper = questionPapers.find((p) => p.id === s.paperId);
  const batch = batches.find((b) => b.id === s.batchId)!;
  const duration = paper?.durationMinutes ?? 30;
  const startHour = s.startHour ?? 10;
  const start = at(s.startDay, startHour);
  const end = s.endHour ? at(s.startDay, s.endHour) : at(s.startDay, startHour + Math.ceil(duration / 60) + 2);
  const rand = seeded(s.id);
  const size = batch.learnerIds.length;
  return {
    id: s.id,
    name: s.name,
    courseId: batch.courseId,
    batchId: s.batchId,
    paperId: s.paperId,
    type: s.type,
    description: `${s.name} for batch ${batch.label}.`,
    instructions:
      "Read every question carefully before answering.\nThe timer starts when you begin and cannot be paused.\nAnswers are saved automatically as you go.\nDo not refresh or close the browser during the assessment.",
    durationMinutes: duration,
    maxAttempts: 1,
    negativeMarking: s.negativeMarking ?? false,
    negativeMarks: s.negativeMarking ? 0.25 : 0,
    settings: { ...defaults, ...s.settings },
    schedule: { mode: "later", start, end, notifyLearners: true, sendReminder: true },
    status: s.status,
    examinerIds: s.examinerIds ?? [],
    createdAt: at(s.startDay - 7 - (i % 3), 15),
    attempted:
      s.status === "Active"
        ? Math.round(size * (0.35 + rand() * 0.3))
        : ["Completed", "Evaluation", "Published"].includes(s.status)
          ? Math.round(size * (0.9 + rand() * 0.08))
          : 0,
  };
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function buildResults(): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const a of assessments) {
    if (!["Completed", "Evaluation", "Published"].includes(a.status)) continue;
    const paper = questionPapers.find((p) => p.id === a.paperId)!;
    const max = paperTotals(paper).marks;
    const batch = batches.find((b) => b.id === a.batchId)!;
    const rand = seeded(`res-${a.id}`);
    const attemptedCount = a.attempted;
    batch.learnerIds.forEach((learnerId, i) => {
      if (i >= attemptedCount) {
        rows.push({ id: `${a.id}-${learnerId}`, learnerId, assessmentId: a.id, score: null, max, status: "Absent", submittedAt: null, timeTakenMinutes: null });
        return;
      }
      const ability = 0.45 + rand() * 0.5;
      const score = Math.round(max * ability * 2) / 2;
      const pending = a.status !== "Published";
      rows.push({
        id: `${a.id}-${learnerId}`,
        learnerId,
        assessmentId: a.id,
        score: pending ? null : score,
        max,
        status: pending ? "Pending evaluation" : score / max >= 0.4 ? "Passed" : "Failed",
        submittedAt: new Date(new Date(a.schedule.start).getTime() + (20 + rand() * 60) * 60000).toISOString(),
        timeTakenMinutes: Math.round(a.durationMinutes * (0.55 + rand() * 0.45)),
      });
    });
  }
  return rows;
}

export const results: ResultRow[] = buildResults();

// ---------------------------------------------------------------------------
// Examiner evaluations
// ---------------------------------------------------------------------------

const SAMPLE_ANSWERS = [
  "The core issue is low completion, which drives early churn. I would focus on the first 45 days because that is where 61% of cancellations happen. Improving onboarding and weekly learning plans would address this directly.",
  "I would prioritise initiatives using expected impact on retention versus effort. Initiative one: personalised study schedules. Initiative two: cohort-based peer groups. The first is cheaper and faster to test, so I would start there.",
  "Primary metric: 45-day retention. Secondary: course completion rate and weekly active learners. Guardrail: support ticket volume per 1,000 learners.",
  "Critical path analysis shows signalling integration is now the constraint. I would fast-track by running integration testing in parallel with the remaining civil works and bring in an additional contractor.",
  "The top risks are contractor claims, integration delays and political pressure on the date. Responses: early claim settlement, a dedicated integration team, and transparent re-baselining with the sponsor.",
];

function subjectiveLeaves(paperId: string) {
  const paper = questionPapers.find((p) => p.id === paperId)!;
  return flatten(paper.questions).filter((q) => !isObjectiveType(q.type) && q.children.length === 0).slice(0, 4);
}

function buildEvaluation(id: string, assessmentId: string, learnerIndex: number, examinerId: string, status: Evaluation["status"], dueDay: number): Evaluation {
  const a = assessments.find((x) => x.id === assessmentId)!;
  const batch = batches.find((b) => b.id === a.batchId)!;
  const leaves = subjectiveLeaves(a.paperId!);
  return {
    id,
    assessmentId,
    learnerId: batch.learnerIds[learnerIndex],
    examinerId,
    status,
    dueDate: at(dueDay, 18),
    answers: leaves.map((q, i) => ({
      questionNumber: q.number,
      questionText: q.text,
      answer: SAMPLE_ANSWERS[(i + learnerIndex) % SAMPLE_ANSWERS.length],
      maxMarks: q.marks,
      marks: status === "Completed" ? Math.max(1, q.marks - ((i + learnerIndex) % 3)) : status === "In progress" && i === 0 ? q.marks - 1 : null,
      comment: status === "Completed" ? "Clear reasoning; could use more evidence from the case." : "",
    })),
  };
}

export const evaluations: Evaluation[] = [
  buildEvaluation("ev-1", "a-spm01-mt", 0, "e-priya", "Pending", 2),
  buildEvaluation("ev-2", "a-spm01-mt", 1, "e-priya", "Pending", 2),
  buildEvaluation("ev-3", "a-spm01-mt", 2, "e-kavita", "In progress", 1),
  buildEvaluation("ev-4", "a-ds01-case", 0, "e-sameer", "Pending", 4),
  buildEvaluation("ev-5", "a-spm01-mt", 3, "e-priya", "Completed", 2),
  buildEvaluation("ev-6", "a-spm01-mt", 4, "e-priya", "Completed", 2),
];

// ---------------------------------------------------------------------------
// Notifications & dashboard activity
// ---------------------------------------------------------------------------

export const notifications: AppNotification[] = [
  { id: "n1", title: "Question paper needs review", body: "GAI-01 – Prompt Engineering Quiz has 1 flagged question.", time: at(0, 8, 40), read: false, href: "/admin/import-questions/p-gai01-quiz" },
  { id: "n2", title: "Assessment is live", body: "Strategic Project Management – Quiz 2 started at 9:00 AM.", time: at(0, 9, 0), read: false, href: "/admin/assessments/a-spm01-quiz2" },
  { id: "n3", title: "Evaluation overdue soon", body: "3 scripts for SPM Mid Term are due in 2 days.", time: at(-1, 17, 15), read: false, href: "/admin/examiners" },
  { id: "n4", title: "Batch import completed", body: "DS-02: 176 learners imported, 124 invitations pending.", time: at(-2, 12, 5), read: true, href: "/admin/batches/b-ds02" },
  { id: "n5", title: "Results published", body: "Product Management – Quiz 2 results are visible to learners.", time: at(-9, 16, 30), read: true, href: "/admin/results" },
];

export interface ActivityPoint {
  date: string; // ISO day
  submissions: number;
}

export const activity: ActivityPoint[] = (() => {
  const rand = seeded("activity");
  const out: ActivityPoint[] = [];
  for (let d = -89; d <= 0; d++) {
    const dow = new Date(at(d, 12)).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const base = weekend ? 40 : 110;
    const bump = d === -10 || d === -4 || d === -2 || d === 0 ? 150 : 0;
    out.push({ date: at(d, 12), submissions: Math.round(base + rand() * 70 + bump) });
  }
  return out;
})();

export interface SystemAlert {
  id: string;
  level: "warning" | "info" | "error";
  title: string;
  body: string;
  href: string;
  cta: string;
}

export const systemAlerts: SystemAlert[] = [
  { id: "sa1", level: "warning", title: "Proctoring provider not configured", body: "1 active assessment has proctoring enabled but no provider is connected.", href: "/admin/proctoring", cta: "Review" },
  { id: "sa2", level: "warning", title: "2 question papers need review", body: "Imported papers with flagged questions cannot be used until approved.", href: "/admin/import-questions?status=Needs%20Review", cta: "Open" },
  { id: "sa3", level: "info", title: "124 learners have not accepted invitations", body: "Batch DS-02 starts in 12 days.", href: "/admin/batches/b-ds02", cta: "View batch" },
];
