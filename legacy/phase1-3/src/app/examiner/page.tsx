import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/shared/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getExaminerDashboard } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function ExaminerDashboardPage() {
  const user = await requireRole("EXAMINER");
  const { profile } = await getExaminerDashboard(user.id);

  return (
    <>
      <PageHeader title={`Welcome, ${user.name}`} description="Submissions assigned to you for evaluation." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pending evaluations</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              title="Nothing to evaluate"
              description="Subjective submissions assigned to you will appear here."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{user.email}</dd>
              <dt className="text-muted-foreground">Last sign-in</dt>
              <dd>{formatDateTime(profile.lastLoginAt)}</dd>
              <dt className="text-muted-foreground">Member since</dt>
              <dd>{formatDateTime(profile.createdAt)}</dd>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
