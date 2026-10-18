import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { toIstInput } from "@/lib/datetime";
import { NotFoundError } from "@/lib/errors";
import { toViewPaper } from "@/lib/papers/view-adapter";
import { requireRole } from "@/server/auth/guards";
import { getAssessment } from "@/server/services/assessments";
import { getAssessmentCommunication } from "@/server/services/communication";
import { listBatches } from "@/server/services/batches";
import { getQuestionPaper, listSelectablePapers } from "@/server/services/question-papers";
import { AssessmentWizard, type WizardStep } from "./assessment-wizard";

export const metadata: Metadata = { title: "Create assessment" };

const HOUR = 3_600_000;

/** Tomorrow 10:00–13:00 IST: the suggested window for a new assessment. */
function defaultWindow(now: Date) {
  const [date] = toIstInput(new Date(now.getTime() + 24 * HOUR)).split("T");
  return { startAt: `${date}T10:00`, endAt: `${date}T13:00` };
}

/**
 * Assessment Builder (admin only). Active batches and every complete question paper come from
 * PostgreSQL; `?edit=<id>` continues an existing draft (or edits a scheduled assessment).
 */
export default async function AssessmentBuilderPage({ searchParams }: PageProps<"/admin/assessments/new">) {
  const actor = await requireRole(Role.ADMIN);
  const { edit, step } = await searchParams;
  const editId = typeof edit === "string" && edit ? edit : null;

  const [batches, papers] = await Promise.all([listBatches(actor, { activeOnly: true }), listSelectablePapers(actor)]);
  const assessment = editId
    ? await getAssessment(actor, editId).catch((err) => {
        if (err instanceof NotFoundError) notFound();
        throw err;
      })
    : null;
  if (assessment && assessment.status !== "DRAFT" && assessment.status !== "SCHEDULED") redirect(`/admin/assessments/${assessment.id}`);
  const paper = assessment?.paper ? toViewPaper(await getQuestionPaper(actor, assessment.paper.id)) : null;
  const communication = assessment ? await getAssessmentCommunication(actor, assessment.id) : null;

  // No course is chosen: the assessment takes its course from the batch. (A deactivated batch of an
  // existing assessment stays selectable in the wizard.)
  const batchOptions = batches.map((b) => ({ id: b.id, name: b.name, code: b.code, courseName: b.course.name, learnerCount: b.learnerCount }));

  return (
    <AssessmentWizard
      key={assessment?.id ?? "new"}
      assessment={assessment}
      paper={paper}
      communication={communication}
      batches={batchOptions}
      papers={papers.map((p) => ({
        id: p.id,
        name: p.name,
        subject: p.subject,
        version: p.version,
        courseId: p.course.id,
        courseName: p.course.name,
        durationMinutes: p.durationMinutes,
        questionCount: p.questionCount,
        sectionCount: p.sectionCount,
        totalMarks: p.totalMarks,
        updatedAt: p.updatedAt,
      }))}
      defaults={defaultWindow(new Date())}
      initialStep={Number(step) as WizardStep}
    />
  );
}
