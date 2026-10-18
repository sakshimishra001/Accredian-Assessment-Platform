import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getQuestionPaper } from "@/server/services/question-papers";
import { PaperDetailView } from "./paper-detail-view";

export const metadata: Metadata = { title: "Question paper" };

/** Read-only view of one question paper, loaded from PostgreSQL. */
export default async function PaperDetailPage({ params }: PageProps<"/admin/import-questions/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const paper = await getQuestionPaper(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return <PaperDetailView paper={paper} />;
}
