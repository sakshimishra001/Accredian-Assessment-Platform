import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BarChart3, CalendarClock, ClipboardList, Plus, SquareCheckBig } from "lucide-react";
import { cn } from "cn";
import { ActivityChart } from "@/components/proto/activity-chart";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AssessmentStatus } from "@/generated/prisma/enums";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { formatDate, formatDateTime, formatNumber } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getAdminOverview } from "@/server/services/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

const RANGES = [7, 30, 90] as const;
const STATUSES: AssessmentStatus[] = ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED"];

type Overview = Awaited<ReturnType<typeof getAdminOverview>>;

/** Headline figures as one divided strip. */
function KpiStrip({ items }: { items: { label: string; value: string | number; hint: string; href: string; attention?: boolean }[] }) {
  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3 xl:grid-cols-6">
      {items.map((k) => (
        <Link key={k.label} href={k.href} className="group bg-card px-4 py-4 transition-colors hover:bg-muted/60">
          <div className="text-xs font-medium text-muted-foreground">{k.label}</div>
          <div className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", k.attention ? "text-amber-700" : "text-foreground")}>{k.value}</div>
          <div className="mt-0.5 text-xs text-muted-foreground group-hover:text-foreground">{k.hint}</div>
        </Link>
      ))}
    </section>
  );
}

/** One audit entry as a sentence. Status changes cover publishing to learners and result publication. */
function describe(a: Overview["recentActivity"][number]) {
  if (a.action === "assessment.created") return "Created as a draft";
  if (a.action === "exam_credential.issued") return `Exam passwords issued${a.metadata.count ? ` to ${a.metadata.count} candidate${a.metadata.count === 1 ? "" : "s"}` : ""}`;
  const { from, to } = a.metadata;
  if (from === "DRAFT" && to === "SCHEDULED") return "Published to learners";
  if (to === "PUBLISHED") return "Results published";
  if (to) return `${from ? `${STATUS_LABEL[from]} → ` : ""}${STATUS_LABEL[to]}`;
  return "Updated";
}

/** Admin home: live figures from PostgreSQL; empty states where there is nothing yet. */
export default async function AdminDashboard({ searchParams }: PageProps<"/admin">) {
  const actor = await requireRole(Role.ADMIN);
  const { range } = await searchParams;
  const days = RANGES.find((r) => String(r) === range) ?? 30;
  const o = await getAdminOverview(actor, days);
  const count = (s: AssessmentStatus) => o.statusCounts[s] ?? 0;
  const maxStatus = Math.max(1, ...STATUSES.map(count));
  const segment = (active: boolean) =>
    cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground");
  const newAssessment = (
    <Link href="/admin/assessments/new" className={buttonVariants()}>
      <Plus /> New assessment
    </Link>
  );

  return (
    <>
      <PageHeader title={`Welcome back, ${actor.name.split(" ")[0]}`} description="Assessment operations at a glance." actions={newAssessment} />

      <KpiStrip
        items={[
          { label: "Assessments", value: formatNumber(o.totalAssessments), hint: "All statuses", href: "/admin/assessments" },
          { label: "Live now", value: count("ACTIVE"), hint: "Open to candidates", href: "/admin/assessments?tab=Active" },
          { label: "Upcoming", value: count("SCHEDULED"), hint: "Scheduled to open", href: "/admin/assessments?tab=Scheduled" },
          { label: "Pending evaluation", value: formatNumber(o.pendingEvaluations), hint: "Submitted, not yet evaluated", href: "/admin/results", attention: o.pendingEvaluations > 0 },
          { label: "Results to publish", value: count("RESULT_READY"), hint: "Evaluation complete", href: "/admin/results", attention: count("RESULT_READY") > 0 },
          { label: "Learners", value: formatNumber(o.learners), hint: `In ${o.batches} active batch${o.batches === 1 ? "" : "es"}`, href: "/admin/batches" },
        ]}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_20rem]">
        <Panel
          title="Submissions"
          description={`Attempts submitted per day (IST) · last ${days} days`}
          actions={
            <div className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <Link key={r} href={`/admin?range=${r}`} aria-current={days === r ? "true" : undefined} className={segment(days === r)}>
                  {r} days
                </Link>
              ))}
            </div>
          }
        >
          {o.totalSubmissions === 0 ? (
            <EmptyState icon={<BarChart3 aria-hidden />} title={`No submissions in the last ${days} days`} description="Submitted attempts appear here by day." />
          ) : (
            <ActivityChart data={o.submissionsPerDay} label="Submissions" />
          )}
        </Panel>

        <Panel title="Assessments by status" description={o.totalAssessments ? `${formatNumber(o.totalAssessments)} in total` : undefined}>
          {o.totalAssessments === 0 ? (
            <EmptyState icon={<ClipboardList aria-hidden />} title="No assessments yet" description="Create an assessment from a question paper." />
          ) : (
            <ul className="grid gap-3">
              {STATUSES.map((st) => (
                <li key={st} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-3 text-sm">
                  <span className="text-muted-foreground">{STATUS_LABEL[st]}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${(count(st) / maxStatus) * 100}%` }} />
                  </span>
                  <span className="text-right font-medium tabular-nums">{count(st)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Panel
          title="Upcoming assessments"
          actions={
            o.upcoming.length ? (
              <Link href="/admin/assessments?tab=Scheduled" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                View all
              </Link>
            ) : null
          }
          bodyClassName="p-0"
        >
          {o.upcoming.length === 0 ? (
            <EmptyState className="m-4" icon={<CalendarClock aria-hidden />} title="No upcoming assessments" description="Scheduled assessments appear here before they open." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Assessment</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Candidates</TableHead>
                  <TableHead className="pr-4">Opens (IST)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.upcoming.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-72 truncate pl-4 font-medium">
                      <Link href={`/admin/assessments/${a.id}`} className="hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.batch?.name ?? "—"}</TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">{formatNumber(a._count.candidates)}</TableCell>
                    <TableCell className="pr-4 text-muted-foreground">{formatDateTime(a.startAt.toISOString())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel
          title="Pending evaluations"
          description={o.pendingEvaluations ? `${formatNumber(o.pendingEvaluations)} submitted attempt${o.pendingEvaluations === 1 ? "" : "s"} awaiting evaluation` : undefined}
          actions={
            o.backlogByExaminer.length ? (
              <Link href="/admin/examiners" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Examiners
              </Link>
            ) : null
          }
        >
          {o.backlogByExaminer.length === 0 ? (
            <EmptyState icon={<SquareCheckBig aria-hidden />} title="Nothing awaiting evaluation" />
          ) : (
            <ul className="divide-y">
              {o.backlogByExaminer.map((row) => (
                <li key={row.id ?? "unassigned"} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    {row.id ? (
                      <Link href={`/admin/examiners/${row.id}`} className="text-sm font-medium hover:underline">
                        {row.name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-amber-700">{row.name}</span>
                    )}
                    <p className="truncate text-xs text-muted-foreground">{row.oldest ? `Oldest submitted ${formatDate(row.oldest.toISOString())}` : null}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="mt-6" title="Recent assessment activity" bodyClassName="p-0">
        {o.recentActivity.length === 0 ? (
          <EmptyState className="m-4" icon={<Activity aria-hidden />} title="No recent activity" description="Creating, publishing and closing assessments shows up here." />
        ) : (
          <ul className="divide-y">
            {o.recentActivity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/admin/assessments/${a.assessmentId}`} className="text-sm font-medium hover:underline">
                    {a.assessmentName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {describe(a)}
                    {a.actorName ? ` · ${a.actorName}` : " · automatically, by schedule"}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(a.at.toISOString())} IST</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
