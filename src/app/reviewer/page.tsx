"use client";

import Link from "next/link";
import { BookOpenCheck } from "lucide-react";
import { EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/prototype/lib/format";
import { paperTotals } from "@/prototype/lib/paper";
import { useLookups, useProto } from "@/prototype/store";

export default function ReviewerDashboard() {
  const s = useProto();
  const lookup = useLookups();
  const queue = s.papers.filter((p) => p.status === "Needs Review" || p.status === "Draft");
  const approved = s.papers.filter((p) => p.status === "Approved");
  return (
    <>
      <PageHeader title="Review Queue" description="Question papers waiting for academic review before they can be used." />
      <div className="mb-6 grid grid-cols-3 gap-3 md:max-w-2xl">
        <MetricCard label="Awaiting review" value={queue.length} tone="attention" />
        <MetricCard label="Flagged questions" value={queue.reduce((n, p) => n + paperTotals(p).needsReview, 0)} />
        <MetricCard label="Approved papers" value={approved.length} />
      </div>
      <Panel title="Papers to review" bodyClassName="p-0">
        {queue.length === 0 ? (
          <EmptyState className="m-4" icon={BookOpenCheck} title="Nothing to review" description="New imports will appear here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Question paper</TableHead>
                <TableHead>Course</TableHead>
                <TableHead className="text-right">Questions</TableHead>
                <TableHead className="text-right">Flagged</TableHead>
                <TableHead>Imported</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.map((p) => {
                const t = paperTotals(p);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="pl-4 font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">{lookup.course(p.courseId)?.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.questions}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.needsReview ? <span className="font-medium text-amber-700">{t.needsReview}</span> : 0}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(p.importedOn)}</TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Link href={`/reviewer/papers/${p.id}`} className={buttonVariants({ size: "sm" })}>
                        Review
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
