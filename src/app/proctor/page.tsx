import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { formatDateTime, formatDuration, formatNumber } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listProctorAssessments } from "@/server/services/proctor-monitoring";
import { AutoRefresh } from "./auto-refresh";

export const metadata: Metadata = { title: "Assigned assessments" };

const iso = (d: Date) => d.toISOString();

/** The assessments this proctor is assigned to (an administrator sees all published ones). */
export default async function ProctorHome() {
  const actor = await requireRole(Role.REVIEWER, Role.ADMIN);
  const now = new Date();
  const assessments = await listProctorAssessments(actor, now);
  return (
    <>
      <PageHeader
        title="Assigned Assessments"
        description={actor.role === Role.ADMIN ? "As an administrator you can monitor every published assessment." : "The assessments you are assigned to proctor."}
        actions={<AutoRefresh asOf={now} everyMs={30_000} />}
      />
      {assessments.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="No assessments to proctor" description="An administrator assigns proctors on each assessment’s Proctors tab." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Assessment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Window (IST)</TableHead>
                <TableHead className="text-right">Active attempts</TableHead>
                <TableHead className="text-right">Learners</TableHead>
                <TableHead className="pr-4 text-right">Monitor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assessments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-4">
                    <Link href={`/proctor/assessments/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {[a.batchName, formatDuration(a.durationMinutes), a.proctoringEnabled ? "Proctoring on" : "Proctoring off"].filter(Boolean).join(" · ")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={STATUS_LABEL[a.status]} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(iso(a.startAt))}
                    <span className="block text-xs">to {formatDateTime(iso(a.endAt))}</span>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatNumber(a.activeAttempts)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatNumber(a.assignedLearners)}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Link href={`/proctor/assessments/${a.id}`} className={buttonVariants({ size: "sm", variant: a.activeAttempts ? "default" : "outline" })}>
                      Monitor
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
