import type { Metadata } from "next";
import Link from "next/link";
import { UserCog } from "lucide-react";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Role } from "@/lib/auth/rbac";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listExaminers } from "@/server/services/examiners";

export const metadata: Metadata = { title: "Examiners" };

/** Examiners and their real workload from PostgreSQL. Accounts are managed in Users & Roles. */
export default async function ExaminersPage() {
  const actor = await requireRole(Role.ADMIN);
  const examiners = await listExaminers(actor);
  const sum = (k: "pendingEvaluations" | "completedEvaluations") => examiners.reduce((n, e) => n + e[k], 0);

  return (
    <>
      <PageHeader
        title="Examiners"
        description="Subject experts who evaluate written answers. Assign them to candidates from an assessment’s Examiners tab."
        actions={
          <Link href="/admin/users" className={buttonVariants({ variant: "outline" })}>
            Manage accounts
          </Link>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Examiners" value={examiners.length} />
        <MetricCard label="Active" value={examiners.filter((e) => e.status === "ACTIVE").length} />
        <MetricCard label="Pending evaluations" value={sum("pendingEvaluations")} tone={sum("pendingEvaluations") ? "attention" : undefined} />
        <MetricCard label="Completed evaluations" value={sum("completedEvaluations")} />
      </div>

      <div className="rounded-lg border bg-card">
        {examiners.length === 0 ? (
          <EmptyState className="m-4" icon={<UserCog aria-hidden />} title="No examiners yet" description="Create examiner accounts in Users & Roles." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Assigned assessments</TableHead>
                <TableHead className="text-right">Pending evaluations</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {examiners.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-4 font-medium">
                    <Link href={`/admin/examiners/${e.id}`} className="hover:underline">
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.email}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.assignedAssessments}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.pendingEvaluations ? <span className="font-medium text-amber-700">{e.pendingEvaluations}</span> : 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.completedEvaluations}</TableCell>
                  <TableCell className="text-muted-foreground">{e.lastLoginAt ? formatDateTime(e.lastLoginAt.toISOString()) : "Never"}</TableCell>
                  <TableCell className="pr-4">
                    <StatusBadge status={e.status === "ACTIVE" ? "Active" : "Disabled"} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
