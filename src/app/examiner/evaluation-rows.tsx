import Link from "next/link";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/prototype/lib/format";
import type { listMyEvaluations } from "@/server/services/evaluations";

export type EvaluationRow = Awaited<ReturnType<typeof listMyEvaluations>>[number];

export const EVALUATION_LABEL: Record<EvaluationRow["evaluationStatus"], string> = { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETED: "Completed" };

/** Submitted attempts of the examiner's assigned candidates (server component). */
export function EvaluationRows({ rows, empty }: { rows: EvaluationRow[]; empty: string }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Candidate</TableHead>
          <TableHead>Assessment</TableHead>
          <TableHead>Answers to mark</TableHead>
          <TableHead>Submitted</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">
            <span className="sr-only">Open</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.attemptId}>
            <TableCell className="pl-4">
              <div className="font-medium">{e.learner.name}</div>
              <div className="text-xs text-muted-foreground">
                {e.learner.email} · attempt #{e.attemptNumber}
              </div>
            </TableCell>
            <TableCell className="max-w-64 truncate text-muted-foreground">{e.assessment.name}</TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {e.answersToMark === 0 ? "None (auto-scored)" : `${e.answersToMark - e.pending}/${e.answersToMark} marked`}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime(e.submittedAt?.toISOString())}</TableCell>
            <TableCell>
              <StatusBadge status={EVALUATION_LABEL[e.evaluationStatus]} />
            </TableCell>
            <TableCell className="pr-4 text-right">
              <Link
                href={`/examiner/evaluations/${e.attemptId}`}
                className={buttonVariants({ size: "sm", variant: e.evaluationStatus === "COMPLETED" ? "outline" : "default" })}
                aria-label={`${e.evaluationStatus === "COMPLETED" ? "View" : "Evaluate"} ${e.learner.name}`}
              >
                {e.evaluationStatus === "COMPLETED" ? "View" : e.evaluationStatus === "IN_PROGRESS" ? "Continue" : "Evaluate"}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
