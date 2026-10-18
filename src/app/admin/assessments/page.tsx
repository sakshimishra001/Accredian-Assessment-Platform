import type { Metadata } from "next";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listAssessments } from "@/server/services/assessments";
import { listBatches } from "@/server/services/batches";
import { listCourses } from "@/server/services/courses";
import { AssessmentsView } from "./assessments-view";

export const metadata: Metadata = { title: "Assessments" };

/** Request time, passed to the view so date filters agree between server and client renders. */
const requestTime = () => Date.now();

/** Assessment list, loaded from PostgreSQL (admin only). Statuses are brought up to date by the service. */
export default async function AssessmentsPage({ searchParams }: PageProps<"/admin/assessments">) {
  const actor = await requireRole(Role.ADMIN);
  const { tab } = await searchParams;
  const [{ rows }, courses, batches] = await Promise.all([listAssessments(actor, { includeArchived: true }), listCourses(actor), listBatches(actor)]);
  return (
    <AssessmentsView
      rows={rows}
      courses={courses.map((c) => ({ id: c.id, name: c.name }))}
      batches={batches.map((b) => ({ id: b.id, name: b.name, courseId: b.course.id }))}
      initialTab={typeof tab === "string" ? tab : undefined}
      now={requestTime()}
    />
  );
}
