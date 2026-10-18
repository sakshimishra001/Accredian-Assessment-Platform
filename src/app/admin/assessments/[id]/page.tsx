import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { toViewPaper } from "@/lib/papers/view-adapter";
import { requireRole } from "@/server/auth/guards";
import { getLiveControl } from "@/server/services/assessment-pause";
import { getAssessment, listAssessmentLearners } from "@/server/services/assessments";
import { listCandidates } from "@/server/services/candidates";
import { learnerPasswordStatus } from "@/server/services/learner-passwords";
import { listExaminers } from "@/server/services/learners";
import { getQuestionPaper } from "@/server/services/question-papers";
import { AssessmentDetailView, type DetailTab } from "./assessment-detail-view";

export const metadata: Metadata = { title: "Assessment" };

const TABS: DetailTab[] = ["overview", "paper", "learners"];

/** One assessment, loaded from PostgreSQL: settings, its frozen question paper and its candidates. */
export default async function AssessmentPage({ params, searchParams }: PageProps<"/admin/assessments/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const { tab } = await searchParams;
  const assessment = await getAssessment(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  // Live control: while live or paused — and after the end while full-duration attempts still run.
  const live = ["ACTIVE", "PAUSED", "ENDED"].includes(assessment.status) ? await getLiveControl(actor, id) : null;
  const [paper, candidates, batchLearners, examiners] = await Promise.all([
    assessment.paper ? getQuestionPaper(actor, assessment.paper.id).then(toViewPaper) : null,
    listCandidates(actor, id),
    listAssessmentLearners(actor, id),
    listExaminers(actor),
  ]);
  // Whether each learner has a password (never the password or its hash).
  const passwords = await learnerPasswordStatus(
    actor,
    candidates.map((c) => c.learner.id),
  );
  return (
    <AssessmentDetailView
      assessment={assessment}
      live={live && (live.status === "ACTIVE" || live.status === "PAUSED" || (live.status === "ENDED" && live.runningAttempts > 0)) ? { ...live, status: live.status } : null}
      paper={paper}
      candidates={candidates.map((c) => {
        const pw = passwords.get(c.learner.id);
        return { id: c.id, name: c.learner.name, email: c.learner.email, status: c.learner.status, assignedAt: c.createdAt, password: { set: !!pw?.hasPassword, lastLoginAt: pw?.lastLoginAt ?? null }, examiner: c.examiner ? { id: c.examiner.id, name: c.examiner.name } : null };
      })}
      batchLearners={batchLearners}
      examiners={examiners.filter((e) => e.status === "ACTIVE").map((e) => ({ id: e.id, name: e.name, email: e.email }))}
      initialTab={TABS.find((t) => t === tab) ?? "overview"}
    />
  );
}
