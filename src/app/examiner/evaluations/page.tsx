import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "cn";
import { PageHeader, Panel } from "@/components/proto/page";
import { Role } from "@/lib/auth/rbac";
import { requireRole } from "@/server/auth/guards";
import { listMyEvaluations } from "@/server/services/evaluations";
import { EvaluationRows } from "../evaluation-rows";

export const metadata: Metadata = { title: "Evaluations" };

/** The examiner's evaluation queue (assigned candidates only), pending or completed. */
export default async function EvaluationsPage({ searchParams }: PageProps<"/examiner/evaluations">) {
  const actor = await requireRole(Role.EXAMINER);
  const tab = (await searchParams).tab === "completed" ? "completed" : "pending";
  const rows = await listMyEvaluations(actor);
  const pending = rows.filter((r) => r.evaluationStatus !== "COMPLETED");
  const completed = rows.filter((r) => r.evaluationStatus === "COMPLETED");
  return (
    <>
      <PageHeader title="Evaluations" description="Mark written answers of the candidates assigned to you." />
      <div className="mb-4 flex gap-1 border-b" role="tablist">
        {(
          [
            ["pending", `Pending (${pending.length})`],
            ["completed", `Completed (${completed.length})`],
          ] as const
        ).map(([k, l]) => (
          <Link
            key={k}
            href={k === "completed" ? "/examiner/evaluations?tab=completed" : "/examiner/evaluations"}
            role="tab"
            aria-selected={tab === k}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {l}
          </Link>
        ))}
      </div>
      <Panel bodyClassName="p-0">
        {tab === "pending" ? <EvaluationRows rows={pending} empty="Nothing waiting — you’re all caught up." /> : <EvaluationRows rows={completed} empty="No completed evaluations yet." />}
      </Panel>
    </>
  );
}
