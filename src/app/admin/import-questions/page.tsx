import type { Metadata } from "next";
import { Role } from "@/lib/auth/rbac";
import { paperUsageLabel } from "@/lib/papers/rules";
import { requireRole } from "@/server/auth/guards";
import { listCourses } from "@/server/services/courses";
import { listQuestionPapers } from "@/server/services/question-papers";
import { LibraryView } from "./library-view";

export const metadata: Metadata = { title: "Import Questions" };

/** The question paper library, from PostgreSQL (admin only). */
export default async function ImportQuestionsPage() {
  const actor = await requireRole(Role.ADMIN);
  const [papers, courses] = await Promise.all([listQuestionPapers(actor), listCourses(actor)]);
  return (
    <LibraryView
      courses={courses.map((c) => ({ id: c.id, name: c.name }))}
      papers={papers.map((p) => ({
        id: p.id,
        name: p.name,
        subject: p.subject,
        course: p.course,
        usage: p.inUse ? "IN_USE" : p.ready ? "READY" : "INCOMPLETE",
        usageLabel: paperUsageLabel(p),
        version: p.version,
        sourceFileName: p.sourceFileName,
        questionCount: p.questionCount,
        sectionCount: p.sectionCount,
        totalMarks: p.totalMarks,
        updatedAt: p.updatedAt.toISOString(),
      }))}
    />
  );
}
