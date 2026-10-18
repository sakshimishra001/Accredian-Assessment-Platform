import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { canEditPaper } from "@/lib/papers/rules";
import { requireRole } from "@/server/auth/guards";
import { getQuestionPaper } from "@/server/services/question-papers";
import { PaperEditor, type EditorStep } from "./paper-editor";

export const metadata: Metadata = { title: "Edit question paper" };

const STEPS: EditorStep[] = ["details", "review", "finish"];

/** Paper editor: structure, questions, finish. Loaded from PostgreSQL; a paper used by an assessment goes to the read-only view. */
export default async function EditQuestionPaperPage({ params, searchParams }: PageProps<"/admin/import-questions/[id]/edit">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const { step } = await searchParams;
  const paper = await getQuestionPaper(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  if (!canEditPaper(paper.assessmentCount)) redirect(`/admin/import-questions/${id}`);
  return <PaperEditor paper={paper} step={STEPS.find((s) => s === step) ?? "details"} />;
}
