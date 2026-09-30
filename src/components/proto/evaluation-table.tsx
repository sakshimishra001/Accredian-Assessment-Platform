"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/prototype/lib/format";
import { useLookups } from "@/prototype/store";
import type { Evaluation } from "@/prototype/types";
import { StatusBadge } from "./status-badge";

export function EvaluationTable({ rows, empty }: { rows: Evaluation[]; empty: string }) {
  const lookup = useLookups();
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Script</TableHead>
          <TableHead>Assessment</TableHead>
          <TableHead>Questions</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-4 text-right">
            <span className="sr-only">Open</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => {
          const marked = e.answers.filter((a) => a.marks !== null).length;
          return (
            <TableRow key={e.id}>
              <TableCell className="pl-4">
                <div className="font-medium">{lookup.learner(e.learnerId)?.name}</div>
                <div className="text-xs text-muted-foreground">Script {e.id.toUpperCase()}</div>
              </TableCell>
              <TableCell className="max-w-64 truncate text-muted-foreground">{lookup.assessment(e.assessmentId)?.name}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {marked}/{e.answers.length} marked
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(e.dueDate)}</TableCell>
              <TableCell>
                <StatusBadge status={e.status} />
              </TableCell>
              <TableCell className="pr-4 text-right">
                <Link href={`/examiner/evaluations/${e.id}`} className={buttonVariants({ size: "sm", variant: e.status === "Completed" ? "outline" : "default" })}>
                  {e.status === "Completed" ? "View" : e.status === "In progress" ? "Continue" : "Evaluate"}
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
