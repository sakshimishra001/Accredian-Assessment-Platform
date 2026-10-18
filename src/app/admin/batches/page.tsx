import type { Metadata } from "next";
import { toBatchRow } from "@/lib/academic/view";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listBatches } from "@/server/services/batches";
import { listCourses } from "@/server/services/courses";
import { BatchesView } from "./batches-view";

export const metadata: Metadata = { title: "Batches & Learners" };

/** Batches from PostgreSQL (admin only); the interactive table lives in BatchesView. */
export default async function BatchesPage() {
  const actor = await requireRole(Role.ADMIN);
  const [courses, batches] = await Promise.all([listCourses(actor), listBatches(actor)]);
  return (
    <BatchesView
      courses={courses.map((c) => ({ id: c.id, code: c.code, name: c.name, isActive: c.isActive }))}
      batches={batches.map((b) => toBatchRow(b))}
    />
  );
}
