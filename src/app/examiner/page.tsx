"use client";

import Link from "next/link";
import { EvaluationTable } from "@/components/proto/evaluation-table";
import { useMyEvaluations } from "@/components/proto/examiner-data";
import { MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/prototype/lib/format";
import { useLookups } from "@/prototype/store";

export default function ExaminerDashboard() {
  const { me, pending, completed, assigned } = useMyEvaluations();
  const lookup = useLookups();
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.name}`}
        description={`${me.specialization} · scripts assigned to you for evaluation`}
        actions={
          <Link href="/examiner/evaluations" className={buttonVariants()}>
            Open evaluations
          </Link>
        }
      />
      <div className="mb-6 grid grid-cols-3 gap-3 md:max-w-2xl">
        <MetricCard label="Pending Evaluations" value={pending.length} tone="attention" href="/examiner/evaluations" />
        <MetricCard label="Completed Evaluations" value={completed.length} href="/examiner/evaluations?tab=completed" />
        <MetricCard label="Assigned Assessments" value={assigned.length} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Pending evaluations" bodyClassName="p-0">
          <EvaluationTable rows={pending} empty="Nothing waiting — you’re all caught up." />
        </Panel>
        <Panel title="Assigned assessments">
          {assigned.length === 0 ? (
            <p className="text-sm text-muted-foreground">No assessments assigned.</p>
          ) : (
            <ul className="grid gap-3">
              {assigned.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {lookup.batch(a.batchId)?.label} · {formatDate(a.schedule.start)}
                    </span>
                  </span>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel className="mt-6" title="Completed evaluations" bodyClassName="p-0">
        <EvaluationTable rows={completed} empty="No completed evaluations yet." />
      </Panel>
    </>
  );
}
