import type { Metadata } from "next";
import type { ImportMethodKey } from "@/components/proto/import-methods";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listCourses } from "@/server/services/courses";
import { NewPaperView } from "./new-paper-view";

export const metadata: Metadata = { title: "Import question paper" };

const METHODS = ["excel", "word", "pdf", "manual"] as const;

/** Start a question paper: import a file or create manually (admin only). Courses come from PostgreSQL. */
export default async function NewQuestionPaperPage({ searchParams }: PageProps<"/admin/import-questions/new">) {
  const actor = await requireRole(Role.ADMIN);
  const { method } = await searchParams;
  const courses = await listCourses(actor, { activeOnly: true });
  return (
    <NewPaperView
      courses={courses.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
      initialMethod={METHODS.find((m) => m === method) as ImportMethodKey | "manual" | undefined ?? null}
    />
  );
}
