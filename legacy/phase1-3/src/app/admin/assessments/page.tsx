import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { cn } from "cn";
import { StatusBadge } from "@/components/admin/badges";
import { EmptyState, PageHeader } from "@/components/shared/app-shell";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AssessmentStatus } from "@/generated/prisma/enums";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/assessments/lifecycle";
import { formatDateTime } from "@/lib/format";
import { ASSESSMENT_TYPE_LABEL } from "@/lib/validation/assessment";
import { requireRole } from "@/server/auth/guards";
import { listAssessments } from "@/server/services/assessments";

export const metadata: Metadata = { title: "Assessments" };

export default async function AssessmentsPage({ searchParams }: PageProps<"/admin/assessments">) {
  const actor = await requireRole("ADMIN");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = STATUS_ORDER.includes(sp.status as AssessmentStatus) ? (sp.status as AssessmentStatus) : undefined;

  const { rows, statusCounts } = await listAssessments(actor, { q, status });
  const activeTotal = Object.entries(statusCounts)
    .filter(([s]) => s !== "ARCHIVED")
    .reduce((n, [, c]) => n + (c ?? 0), 0);

  const tabHref = (s?: AssessmentStatus) => {
    const params = new URLSearchParams();
    if (s) params.set("status", s);
    if (q) params.set("q", q);
    const str = params.toString();
    return `/admin/assessments${str ? `?${str}` : ""}`;
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Assessments" description="Create, schedule and track assessments." />
        <Link href="/admin/assessments/new" className={buttonVariants()}>
          <Plus /> New assessment
        </Link>
      </div>

      <nav className="mb-4 flex flex-wrap gap-1 border-b" aria-label="Filter by status">
        {[undefined, ...STATUS_ORDER].map((s) => {
          const count = s ? (statusCounts[s] ?? 0) : activeTotal;
          const active = s === status;
          return (
            <Link
              key={s ?? "all"}
              href={tabHref(s)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {s ? STATUS_LABEL[s] : "All"} <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            </Link>
          );
        })}
      </nav>

      <form className="mb-4 flex gap-2" role="search">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <Input name="q" defaultValue={q} placeholder="Search by name…" className="w-64" aria-label="Search assessments" />
        <button type="submit" className={buttonVariants({ variant: "secondary" })}>
          Search
        </button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={q || status ? "No assessments match" : "No assessments yet"}
          description={q || status ? undefined : "Create your first assessment to get started."}
        />
      ) : (
        <div className="rounded-xl ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Window (IST)</TableHead>
                <TableHead className="text-right">Questions</TableHead>
                <TableHead className="text-right">Marks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/admin/assessments/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{a.durationMinutes} min</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.course.code}</TableCell>
                  <TableCell>{ASSESSMENT_TYPE_LABEL[a.type]}</TableCell>
                  <TableCell><StatusBadge status={a.status} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(a.startAt)}
                    <br />→ {formatDateTime(a.endAt)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{a.questionCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.totalMarks}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
