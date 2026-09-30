"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Info, SquareCheckBig } from "lucide-react";
import { cn } from "cn";
import { ActivityChart } from "@/components/proto/activity-chart";
import { Field } from "@/components/proto/controls";
import { EmptyState, PageHeader, Panel } from "@/components/proto/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { systemAlerts } from "@/prototype/data/activity";
import { formatDate, formatDateTime, formatNumber, formatRelative, toIstParts } from "@/prototype/lib/format";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { activity, useLookups, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { AssessmentStatus } from "@/prototype/types";

type Range = "7" | "30" | "90" | "custom";
const STATUS_ORDER: AssessmentStatus[] = ["Draft", "Scheduled", "Active", "Completed", "Evaluation", "Published"];

interface Kpi {
  label: string;
  value: string | number;
  hint: string;
  href: string;
  attention?: boolean;
}

/** Headline figures as one divided strip rather than six separate cards. */
function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3 xl:grid-cols-6">
      {items.map((k) => (
        <Link key={k.label} href={k.href} className="group bg-card px-4 py-3.5 transition-colors hover:bg-muted/60">
          <div className="text-xs font-medium text-muted-foreground">{k.label}</div>
          <div className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums", k.attention && "text-amber-700")}>{k.value}</div>
          <div className="mt-0.5 text-xs text-muted-foreground group-hover:text-foreground">{k.hint}</div>
        </Link>
      ))}
    </section>
  );
}

export default function AdminDashboard() {
  const s = useProto();
  const lookup = useLookups();
  const router = useRouter();
  const toast = useToast();
  const [range, setRange] = useState<Range>("30");
  const [customOpen, setCustomOpen] = useState(false);
  const today = toIstParts(new Date(DEMO_DAY_START + 12 * 3600000).toISOString()).date;
  const [custom, setCustom] = useState({ from: toIstParts(activity[60].date).date, to: today });
  const [customError, setCustomError] = useState<string | null>(null);
  const now = DEMO_DAY_START + 12 * 3600000;

  const series = useMemo(() => {
    const points = activity.map((a) => ({ date: a.date, value: a.submissions }));
    if (range === "custom") {
      return points.filter((p) => {
        const d = toIstParts(p.date).date;
        return d >= custom.from && d <= custom.to;
      });
    }
    return points.slice(-Number(range));
  }, [range, custom]);

  const byStatus = useMemo(
    () => Object.fromEntries(STATUS_ORDER.map((st) => [st, s.assessments.filter((a) => a.status === st).length])) as Record<AssessmentStatus, number>,
    [s.assessments],
  );
  const pendingEvals = s.evaluations.filter((e) => e.status !== "Completed");
  const upcoming = s.assessments
    .filter((a) => a.status === "Scheduled")
    .sort((a, b) => a.schedule.start.localeCompare(b.schedule.start))
    .slice(0, 5);
  const pendingByExaminer = Object.entries(pendingEvals.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.examinerId]: (acc[e.examinerId] ?? 0) + 1 }), {}));
  const maxStatus = Math.max(1, ...Object.values(byStatus));
  const rangeLabel = range === "custom" ? `${formatDate(`${custom.from}T06:30:00Z`)} – ${formatDate(`${custom.to}T06:30:00Z`)}` : `last ${range} days`;
  const segment = (active: boolean) =>
    cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground");

  return (
    <>
      <PageHeader
        title="Welcome back, Admin"
        description="Here’s what’s happening with your assessments."
        actions={
          <div className="flex items-center gap-0.5 rounded-lg border bg-card p-0.5" role="group" aria-label="Date range">
            {(["7", "30", "90"] as const).map((r) => (
              <button key={r} type="button" onClick={() => setRange(r)} aria-pressed={range === r} className={segment(range === r)}>
                Last {r} days
              </button>
            ))}
            <Popover open={customOpen} onOpenChange={setCustomOpen}>
              <PopoverTrigger aria-pressed={range === "custom"} className={segment(range === "custom")}>
                Custom
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                <div className="grid gap-3">
                  <p className="text-sm font-medium">Custom range</p>
                  <Field label="From" htmlFor="from">
                    <Input id="from" type="date" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                  </Field>
                  <Field label="To" htmlFor="to" error={customError}>
                    <Input id="to" type="date" value={custom.to} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
                  </Field>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!custom.from || !custom.to || custom.from > custom.to) {
                        setCustomError("The end date must be on or after the start date.");
                        return;
                      }
                      setCustomError(null);
                      setRange("custom");
                      setCustomOpen(false);
                    }}
                  >
                    Apply range
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        }
      />

      <KpiStrip
        items={[
          { label: "Total Assessments", value: s.assessments.length, hint: "All statuses", href: "/admin/assessments" },
          { label: "Upcoming Assessments", value: byStatus.Scheduled, hint: "Scheduled to start", href: "/admin/assessments?tab=Scheduled" },
          { label: "Active Assessments", value: byStatus.Active, hint: "Live right now", href: "/admin/assessments?tab=Active" },
          { label: "Pending Evaluation", value: pendingEvals.length, hint: "Scripts with examiners", href: "/admin/examiners", attention: pendingEvals.length > 0 },
          { label: "Learners", value: formatNumber(s.learners.length), hint: `Across ${s.batches.length} batches`, href: "/admin/batches" },
          { label: "Question Papers", value: s.papers.length, hint: `${s.papers.filter((p) => p.status === "Approved").length} approved`, href: "/admin/import-questions" },
        ]}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_20rem]">
        <Panel title="Recent assessment activity" description={`Learner submissions per day · ${rangeLabel}`}>
          {series.length === 0 ? <EmptyState title="No activity in this range" description="Choose a different date range." /> : <ActivityChart data={series} label="Submissions" />}
        </Panel>

        <Panel title="Assessment status" description={`${s.assessments.length} assessments`}>
          <ul className="grid gap-3">
            {STATUS_ORDER.map((st) => (
              <li key={st}>
                <Link href={`/admin/assessments?tab=${st}`} className="group grid grid-cols-[6rem_1fr_2rem] items-center gap-3 text-sm">
                  <span className="text-muted-foreground group-hover:text-foreground">{st}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${(byStatus[st] / maxStatus) * 100}%` }} />
                  </span>
                  <span className="text-right font-medium tabular-nums">{byStatus[st]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Panel
          title="Upcoming assessments"
          actions={
            <Link href="/admin/assessments?tab=Scheduled" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              View all
            </Link>
          }
          bodyClassName="p-0"
        >
          {upcoming.length === 0 ? (
            <EmptyState className="m-4" icon={CalendarClock} title="Nothing scheduled" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Assessment</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Learners</TableHead>
                  <TableHead>Opens (IST)</TableHead>
                  <TableHead className="pr-4 text-right">Starts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.map((a) => {
                  const batch = lookup.batch(a.batchId);
                  return (
                    <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/admin/assessments/${a.id}`)}>
                      <TableCell className="max-w-72 truncate pl-4 font-medium">{a.name}</TableCell>
                      <TableCell className="text-muted-foreground">{batch?.label}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">{formatNumber(batch?.learnerIds.length ?? 0)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(a.schedule.start)}</TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground">{formatRelative(a.schedule.start, now)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel
          title="Pending evaluations"
          description={`${pendingEvals.length} scripts awaiting examiners`}
          actions={
            <Link href="/admin/examiners" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Examiners
            </Link>
          }
        >
          {pendingByExaminer.length === 0 ? (
            <EmptyState icon={SquareCheckBig} title="All evaluations are complete" />
          ) : (
            <ul className="divide-y">
              {pendingByExaminer.map(([examinerId, count]) => {
                const ex = lookup.examiner(examinerId);
                const soonest = pendingEvals.filter((e) => e.examinerId === examinerId).map((e) => e.dueDate).sort()[0];
                return (
                  <li key={examinerId} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link href={`/admin/examiners/${examinerId}`} className="text-sm font-medium hover:underline">
                        {ex?.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {count} script{count === 1 ? "" : "s"} · due {formatDate(soonest)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => toast.success("Reminder sent", `${ex?.name} was reminded about ${count} pending script${count === 1 ? "" : "s"} (simulated).`)}>
                      Remind
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="mt-6" title="System alerts" bodyClassName="p-0">
        <ul className="divide-y">
          {systemAlerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {a.level === "warning" ? <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-label="Warning" /> : <Info className="size-4 shrink-0 text-primary" aria-label="Info" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">{a.body}</p>
              </div>
              <Link href={a.href} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {a.cta}
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
