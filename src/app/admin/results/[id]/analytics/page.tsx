import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentAnalyticsView } from "@/components/analytics/assessment-analytics";
import { PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getAssessmentAnalytics } from "@/server/services/analytics";

export const metadata: Metadata = { title: "Assessment analytics" };

/** Assessment-level analytics over every candidate (admin). */
export default async function AdminAnalyticsPage({ params }: PageProps<"/admin/results/[id]/analytics">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const data = await getAssessmentAnalytics(actor, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Results & Reports", href: "/admin/results" }, { label: data.assessment.name, href: `/admin/results/${id}` }, { label: "Analytics" }]}
        title="Assessment Analytics"
        meta={<StatusBadge status={STATUS_LABEL[data.assessment.status]} />}
        description={`${data.assessment.name} · all candidates`}
        actions={
          <Link href={`/admin/results/${id}`} className={buttonVariants({ variant: "outline" })}>
            Candidate results
          </Link>
        }
      />
      <AssessmentAnalyticsView data={data} />
    </>
  );
}
