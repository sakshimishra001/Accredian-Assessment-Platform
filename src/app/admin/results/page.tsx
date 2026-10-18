import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { formatDate } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listResultSummaries } from "@/server/services/results";

export const metadata: Metadata = { title: "Results & Reports" };

/** Assessments in the result stages with attempt / evaluation / publication counts, from PostgreSQL. */
export default async function ResultsPage() {
  const actor = await requireRole(Role.ADMIN);
  const rows = await listResultSummaries(actor);
  const total = (k: "attempts" | "submitted" | "pendingEvaluation" | "evaluationCompleted") => rows.reduce((n, r) => n + r[k], 0);
  return (
    <>
      <PageHeader title="Results & Reports" description="Attempts, evaluation progress and published results by assessment." />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCard label="Total attempts" value={total("attempts")} />
        <MetricCard label="Submitted" value={total("submitted")} />
        <MetricCard label="Pending evaluation" value={total("pendingEvaluation")} tone={total("pendingEvaluation") ? "attention" : undefined} />
        <MetricCard label="Evaluation completed" value={total("evaluationCompleted")} />
        <MetricCard label="Results published" value={rows.filter((r) => r.published).length} hint={`of ${rows.length} assessments`} />
      </div>
      <Panel title="Assessments" bodyClassName="p-0">
        {rows.length === 0 ? (
          <EmptyState className="m-4" icon={<BarChart3 aria-hidden />} title="No results yet" description="Assessments appear here once they are open." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Assessment</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className="text-right">Candidates</TableHead>
                <TableHead className="text-right">Submitted</TableHead>
                <TableHead className="text-right">Pending evaluation</TableHead>
                <TableHead className="text-right">Evaluated</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.course.name} · ended {formatDate(r.endAt.toISOString())}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.batch?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.candidates}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.submitted}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.pendingEvaluation ? <span className="font-medium text-amber-700">{r.pendingEvaluation}</span> : 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.evaluationCompleted}</TableCell>
                  <TableCell>
                    <StatusBadge status={STATUS_LABEL[r.status]} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Link href={`/admin/results/${r.id}`} className={buttonVariants({ size: "sm", variant: "outline" })} aria-label={`Results for ${r.name}`}>
                      Open
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
