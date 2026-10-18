import type { Metadata } from "next";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listCourses } from "@/server/services/courses";
import { CoursesView } from "./courses-view";

export const metadata: Metadata = { title: "Courses" };

/** Courses from PostgreSQL (admin only). */
export default async function CoursesPage() {
  const actor = await requireRole(Role.ADMIN);
  const courses = await listCourses(actor);
  return (
    <CoursesView
      courses={courses.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        description: c.description,
        isActive: c.isActive,
        batchCount: c.batchCount,
        createdAt: c.createdAt.toISOString(),
      }))}
    />
  );
}
