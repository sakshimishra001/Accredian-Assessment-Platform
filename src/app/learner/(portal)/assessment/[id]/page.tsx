import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { forAssessment } from "@/server/auth/session";
import { getMyExamOverview, startOrResumeAttempt, type AttemptView } from "@/server/services/attempts";
import { ExamIntro } from "./exam-intro";
import { ExamScreen } from "./exam-screen";

export const metadata: Metadata = { title: "Assessment" };

/**
 * The learner's exam. The learner comes from the session; the assessment from the URL, served only
 * if the learner is assigned to it (and it isn't a draft) — anything else is "not found", whoever
 * knows the URL. Window, attempt and resume rules are the attempt service's. With an attempt in progress
 * the exam itself is rendered (so a refresh resumes it with the saved answers and the server's
 * remaining time); otherwise the instructions, or the submitted attempt.
 */
export default async function LearnerAssessmentPage({ params }: PageProps<"/learner/assessment/[id]">) {
  const { id } = await params;
  const actor = forAssessment(await requireRole(Role.LEARNER), id);

  const overview = await getMyExamOverview(actor).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  if (!overview.inProgressAttemptId) return <ExamIntro overview={overview} />;

  // Resume through the attempt service, which applies the resume rules (e.g. "resume only from the
  // sign-in that started it") and closes the attempt if its time has run out.
  let view: AttemptView | null = null;
  let blocked: string | undefined;
  try {
    view = await startOrResumeAttempt(actor);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    blocked = err.message;
  }
  if (view?.attempt.status === "IN_PROGRESS") return <ExamScreen key={view.attempt.id} view={view} />;
  // Not resumable here, or its time just ran out (now closed): show the outcome.
  return <ExamIntro overview={await getMyExamOverview(actor)} blocked={blocked} />;
}
