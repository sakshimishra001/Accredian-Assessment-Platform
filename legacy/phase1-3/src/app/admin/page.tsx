import type { Metadata } from "next";
import { EmptyState, PageHeader, StatCard } from "@/components/shared/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getAdminDashboard } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Admin dashboard" };

const ACTION_LABEL: Record<string, string> = {
  "auth.login_succeeded": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
  "question.created": "Question created",
  "question.updated": "Question edited",
  "question.archived": "Question deactivated",
  "question.restored": "Question activated",
  "question.deleted": "Question deleted",
  "assessment.created": "Assessment created",
  "assessment.updated": "Assessment settings changed",
  "assessment.status_changed": "Assessment status changed",
  "assessment.questions_added": "Questions added to assessment",
  "assessment.question_removed": "Question removed from assessment",
  "assessment.question_updated": "Assessment question marks changed",
  "assessment.questions_reordered": "Assessment questions reordered",
  "assessment.question_refreshed": "Assessment question updated to latest version",
};

export default async function AdminDashboardPage() {
  const user = await requireRole("ADMIN");
  const { counts, courses, recentActivity } = await getAdminDashboard();

  return (
    <>
      <PageHeader title={`Welcome, ${user.name}`} description="Overview of the platform." />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Learners" value={counts.learners} />
        <StatCard label="Examiners" value={counts.examiners} />
        <StatCard label="Admins" value={counts.admins} />
        <StatCard label="Courses" value={counts.courses} />
        <StatCard label="Batches" value={counts.batches} />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Courses and batches</CardTitle>
          </CardHeader>
          <CardContent>
            {courses.length === 0 ? (
              <EmptyState title="No courses yet" />
            ) : (
              <ul className="divide-y">
                {courses.map((course) => (
                  <li key={course.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="text-sm font-medium">
                      {course.name} <span className="text-muted-foreground">({course.code})</span>
                    </div>
                    {course.batches.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No batches</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                        {course.batches.map((batch) => (
                          <li key={batch.id}>
                            {batch.name} · {batch._count.members} member
                            {batch._count.members === 1 ? "" : "s"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <EmptyState title="No activity recorded yet" />
            ) : (
              <ul className="divide-y text-sm">
                {recentActivity.map((entry) => (
                  <li key={entry.id} className="flex justify-between gap-4 py-2 first:pt-0 last:pb-0">
                    <span>
                      <span className="font-medium">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                      {entry.actor ? (
                        <span className="text-muted-foreground"> · {entry.actor.name}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
