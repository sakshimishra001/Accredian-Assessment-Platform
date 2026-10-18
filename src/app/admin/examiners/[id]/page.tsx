import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DetailList, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getExaminerOverview } from "@/server/services/examiners";

export const metadata: Metadata = { title: "Examiner" };

type Overview = Awaited<ReturnType<typeof getExaminerOverview>>;
const EVALUATION_LABEL = { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETED: "Completed" } as const;

function EvaluationTable({ rows, empty, when }: { rows: Overview["pending"]; empty: string; when: "submitted" | "finalized" }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Learner</TableHead>
          <TableHead>Assessment</TableHead>
          <TableHead>{when === "submitted" ? "Submitted" : "Finalised"}</TableHead>
          <TableHead className="pr-4">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="pl-4 font-medium">
              <Link href={`/admin/results/${r.assessment.id}/${r.id}`} className="hover:underline">
                {r.learner.name}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{r.assessment.name}</TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime((when === "submitted" ? r.submittedAt : r.evaluationFinalizedAt)?.toISOString())}</TableCell>
            <TableCell className="pr-4">
              <StatusBadge status={EVALUATION_LABEL[r.evaluationStatus]} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One examiner's assignments and evaluation workload, from PostgreSQL. */
export default async function ExaminerDetailPage({ params }: PageProps<"/admin/examiners/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  let data: Overview;
  try {
    data = await getExaminerOverview(actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { examiner, assessments, pending, completed } = data;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Examiners", href: "/admin/examiners" }, { label: examiner.name }]}
        title={examiner.name}
        meta={<StatusBadge status={examiner.status === "ACTIVE" ? "Active" : "Disabled"} />}
        description={examiner.email}
        actions={
          <Link href="/admin/users" className={buttonVariants({ variant: "outline" })}>
            Manage account
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <MetricCard label="Assigned assessments" value={assessments.length} />
        <MetricCard label="Pending evaluations" value={pending.length} tone={pending.length ? "attention" : undefined} />
        <MetricCard label="Completed evaluations" value={completed.length} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <Panel title="Account">
          <DetailList
            className="grid-cols-[6.5rem_1fr]"
            items={[
              ["Email", examiner.email],
              ["Status", examiner.status === "ACTIVE" ? "Active" : "Disabled"],
              ["Last sign-in", examiner.lastLoginAt ? formatDateTime(examiner.lastLoginAt.toISOString()) : "Never"],
              ["Created", formatDateTime(examiner.createdAt.toISOString())],
            ]}
          />
        </Panel>
        <Panel title="Assigned assessments" bodyClassName="p-0">
          {assessments.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Not assigned to any candidates. Assign examiners from an assessment’s Examiners tab.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Assessment</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Candidates</TableHead>
                  <TableHead>Starts</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assessments.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-4">
                      <Link href={`/admin/assessments/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.batch?.name ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.assignedCandidates}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(a.startAt.toISOString())}</TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge status={STATUS_LABEL[a.status]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Pending evaluations" bodyClassName="p-0">
          <EvaluationTable rows={pending} empty="No pending evaluations." when="submitted" />
        </Panel>
        <Panel title="Completed evaluations" bodyClassName="p-0">
          <EvaluationTable rows={completed} empty="No completed evaluations yet." when="finalized" />
        </Panel>
      </div>
    </>
  );
}
