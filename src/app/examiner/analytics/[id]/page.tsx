import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssessmentAnalyticsView } from "@/components/analytics/assessment-analytics";
import { PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getAssessmentAnalytics } from "@/server/services/analytics";

export const metadata: Metadata = { title: "Assessment analytics" };

/**
 * Analytics for an assessment, over the candidates assigned to this examiner only. The service
 * returns "not found" for an assessment where the examiner has no assigned candidates.
 */
export default async function ExaminerAnalyticsPage({ params }: PageProps<"/examiner/analytics/[id]">) {
  const actor = await requireRole(Role.EXAMINER);
  const { id } = await params;
  const data = await getAssessmentAnalytics(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/examiner" }, { label: "Analytics" }]}
        title="Assessment Analytics"
        meta={<StatusBadge status={STATUS_LABEL[data.assessment.status]} />}
        description={`${data.assessment.name} · your assigned candidates only`}
      />
      <AssessmentAnalyticsView data={data} />
    </>
  );
}
