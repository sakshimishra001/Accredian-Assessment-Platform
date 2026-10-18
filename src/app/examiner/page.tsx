import type { Metadata } from "next";
import Link from "next/link";
import { MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { formatDate } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listExaminerAssessments } from "@/server/services/candidates";
import { listMyEvaluations } from "@/server/services/evaluations";
import { EvaluationRows } from "./evaluation-rows";

export const metadata: Metadata = { title: "Examiner dashboard" };

/** Examiner home: only the candidates assigned to this examiner, from PostgreSQL. */
export default async function ExaminerDashboard() {
  const actor = await requireRole(Role.EXAMINER);
  const [rows, assessments] = await Promise.all([listMyEvaluations(actor), listExaminerAssessments(actor)]);
  const pending = rows.filter((r) => r.evaluationStatus !== "COMPLETED");
  const completed = rows.filter((r) => r.evaluationStatus === "COMPLETED");
  return (
    <>
      <PageHeader
        title={`Welcome, ${actor.name}`}
        description="Submitted answers of the candidates assigned to you."
        actions={
          <Link href="/examiner/evaluations" className={buttonVariants()}>
            Open evaluations
          </Link>
        }
      />
      <div className="mb-6 grid grid-cols-3 gap-3 md:max-w-2xl">
        <MetricCard label="Pending Evaluations" value={pending.length} tone={pending.length ? "attention" : undefined} href="/examiner/evaluations" />
        <MetricCard label="Completed Evaluations" value={completed.length} href="/examiner/evaluations?tab=completed" />
        <MetricCard label="Assigned Assessments" value={assessments.length} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Pending evaluations" bodyClassName="p-0">
          <EvaluationRows rows={pending} empty="Nothing waiting — you’re all caught up." />
        </Panel>
        <Panel title="Assigned assessments">
          {assessments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No candidates are assigned to you yet.</p>
          ) : (
            <ul className="grid gap-3">
              {assessments.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {a.assignedCandidates} candidate{a.assignedCandidates === 1 ? "" : "s"} · {formatDate(a.startAt.toISOString())} ·{" "}
                      <Link href={`/examiner/analytics/${a.id}`} className="text-primary hover:underline">
                        Analytics
                      </Link>
                    </span>
                  </span>
                  <StatusBadge status={STATUS_LABEL[a.status]} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel className="mt-6" title="Completed evaluations" bodyClassName="p-0">
        <EvaluationRows rows={completed} empty="No completed evaluations yet." />
      </Panel>
    </>
  );
}
