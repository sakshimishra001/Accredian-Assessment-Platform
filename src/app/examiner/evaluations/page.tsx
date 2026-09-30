"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";
import { EvaluationTable } from "@/components/proto/evaluation-table";
import { useMyEvaluations } from "@/components/proto/examiner-data";
import { PageHeader, Panel } from "@/components/proto/page";
import { withSuspense } from "@/components/proto/suspense-page";

function EvaluationsPage() {
  const params = useSearchParams();
  const { pending, completed } = useMyEvaluations();
  const [tab, setTab] = useState<"pending" | "completed">(params.get("tab") === "completed" ? "completed" : "pending");
  return (
    <>
      <PageHeader title="Evaluations" description="Mark subjective answers and add feedback." />
      <div className="mb-4 flex gap-1 border-b" role="tablist">
        {(
          [
            ["pending", `Pending (${pending.length})`],
            ["completed", `Completed (${completed.length})`],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {l}
          </button>
        ))}
      </div>
      <Panel bodyClassName="p-0">
        {tab === "pending" ? <EvaluationTable rows={pending} empty="Nothing waiting — you’re all caught up." /> : <EvaluationTable rows={completed} empty="No completed evaluations yet." />}
      </Panel>
    </>
  );
}

export default withSuspense(EvaluationsPage);
