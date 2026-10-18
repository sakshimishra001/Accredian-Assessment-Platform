import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getEvaluation } from "@/server/services/evaluations";
import { EvaluationForm } from "./evaluation-form";

export const metadata: Metadata = { title: "Evaluate" };

/**
 * One submitted attempt to evaluate. The id is the attempt's; the service only finds attempts of
 * candidates assigned to this examiner, so anything else is a 404.
 */
export default async function EvaluationPage({ params }: PageProps<"/examiner/evaluations/[id]">) {
  const actor = await requireRole(Role.EXAMINER);
  const { id } = await params;
  const evaluation = await getEvaluation(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return <EvaluationForm key={`${evaluation.attempt.id}-${evaluation.attempt.evaluationStatus}`} evaluation={evaluation} />;
}
