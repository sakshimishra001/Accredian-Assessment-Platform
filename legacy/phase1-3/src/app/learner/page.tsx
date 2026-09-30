import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/shared/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getLearnerDashboard } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function LearnerDashboardPage() {
  const user = await requireRole("LEARNER");
  const { batches } = await getLearnerDashboard(user.id);

  return (
    <>
      <PageHeader title={`Welcome, ${user.name}`} description="Your courses and assessments." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>My assessments</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              title="No assessments assigned"
              description="Assessments assigned to your batch will appear here."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>My batches</CardTitle>
          </CardHeader>
          <CardContent>
            {batches.length === 0 ? (
              <EmptyState title="You are not enrolled in any batch" />
            ) : (
              <ul className="divide-y text-sm">
                {batches.map((batch) => (
                  <li key={batch.id} className="py-2 first:pt-0 last:pb-0">
                    <div className="font-medium">{batch.name}</div>
                    <div className="text-muted-foreground">
                      {batch.course.name} · {formatDate(batch.startDate)} – {formatDate(batch.endDate)}
                    </div>
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
