"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { BarChart3, Download } from "lucide-react";
import { cn } from "cn";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmptyState, MetricCard, PageHeader } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, percent } from "@/prototype/lib/format";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { useLookups, useProto } from "@/prototype/store";
import { useToast } from "@/prototype/toast";

const TABS = ["Assessment Results", "Batch Performance", "Learner Performance", "Examiner Evaluation"] as const;

function ResultsPage() {
  const s = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const params = useSearchParams();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Assessment Results");
  const [assessment, setAssessment] = useState(params.get("assessment") ?? "");
  const [batch, setBatch] = useState("");
  const [course, setCourse] = useState("");
  const [date, setDate] = useState("");
  const [q, setQ] = useState("");

  const withResults = s.assessments.filter((a) => s.results.some((r) => r.assessmentId === a.id));

  const filtered = useMemo(() => {
    const dayMs = 86400000;
    return s.results.filter((r) => {
      const a = lookup.assessment(r.assessmentId);
      if (!a) return false;
      if (assessment && r.assessmentId !== assessment) return false;
      if (batch && a.batchId !== batch) return false;
      if (course && a.courseId !== course) return false;
      if (date) {
        const age = (DEMO_DAY_START - new Date(a.schedule.start).getTime()) / dayMs;
        if (date === "7" && age > 7) return false;
        if (date === "30" && age > 30) return false;
      }
      if (q.trim() && !lookup.learner(r.learnerId)?.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
      return true;
    });
  }, [s.results, assessment, batch, course, date, q, lookup]);

  const pager = usePagination(filtered, 12);
  const scored = filtered.filter((r) => r.score !== null);
  const avgPct = scored.length ? scored.reduce((n, r) => n + percent(r.score!, r.max), 0) / scored.length : 0;

  const batchRows = useMemo(
    () =>
      s.batches
        .map((b) => {
          const rs = filtered.filter((r) => lookup.assessment(r.assessmentId)?.batchId === b.id);
          const sc = rs.filter((r) => r.score !== null);
          return {
            b,
            assessments: new Set(rs.map((r) => r.assessmentId)).size,
            submitted: rs.filter((r) => r.status !== "Absent").length,
            avg: sc.length ? sc.reduce((n, r) => n + percent(r.score!, r.max), 0) / sc.length : null,
            pass: sc.length ? percent(sc.filter((r) => r.status === "Passed").length, sc.length) : null,
          };
        })
        .filter((x) => x.assessments > 0),
    [s.batches, filtered, lookup],
  );

  const learnerRows = useMemo(() => {
    const map = new Map<string, { total: number; count: number; attempts: number }>();
    for (const r of filtered) {
      if (r.status === "Absent") continue;
      const m = map.get(r.learnerId) ?? { total: 0, count: 0, attempts: 0 };
      m.attempts += 1;
      if (r.score !== null) {
        m.total += percent(r.score, r.max);
        m.count += 1;
      }
      map.set(r.learnerId, m);
    }
    return [...map.entries()]
      .map(([id, m]) => ({ id, attempts: m.attempts, avg: m.count ? m.total / m.count : null }))
      .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  }, [filtered]);
  const learnerPager = usePagination(learnerRows, 12);

  const examinerRows = s.examiners.map((e) => {
    const evs = s.evaluations.filter((x) => x.examinerId === e.id);
    return { e, total: evs.length, pending: evs.filter((x) => x.status !== "Completed").length, done: evs.filter((x) => x.status === "Completed").length };
  });

  return (
    <>
      <PageHeader
        title="Results & Reports"
        description="Outcomes by assessment, batch, learner and examiner."
        actions={
          <Button variant="outline" onClick={() => toast.info("Result export will be available in the next phase.")}>
            <Download /> Export Results
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap", tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t}
          </button>
        ))}
      </div>

      {tab !== "Examiner Evaluation" ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <SearchInput value={q} onChange={setQ} placeholder="Search learner…" />
          <SelectField value={assessment} onChange={setAssessment} placeholder="All assessments" ariaLabel="Assessment" options={withResults.map((a) => ({ value: a.id, label: a.name }))} />
          <SelectField value={batch} onChange={setBatch} placeholder="All batches" ariaLabel="Batch" options={s.batches.map((b) => ({ value: b.id, label: b.label }))} />
          <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={s.courses.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField value={date} onChange={setDate} placeholder="Any date" ariaLabel="Date" options={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }]} />
        </div>
      ) : null}

      {tab === "Assessment Results" ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Results" value={formatNumber(filtered.length)} />
            <MetricCard label="Scored" value={formatNumber(scored.length)} />
            <MetricCard label="Average" value={scored.length ? `${avgPct.toFixed(1)}%` : "—"} />
            <MetricCard label="Pending evaluation" value={formatNumber(filtered.filter((r) => r.status === "Pending evaluation").length)} tone="attention" />
          </div>
          <div className="rounded-lg border bg-card">
            {filtered.length === 0 ? (
              <EmptyState className="m-4" icon={BarChart3} title="No results match these filters" />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Learner</TableHead>
                      <TableHead>Assessment</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead className="text-right">Maximum</TableHead>
                      <TableHead className="text-right">Percentage</TableHead>
                      <TableHead className="pr-4">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pager.slice.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="pl-4">
                          <Link href={`/admin/results/${r.id}`} className="font-medium hover:underline">
                            {lookup.learner(r.learnerId)?.name}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-64 truncate text-muted-foreground">{lookup.assessment(r.assessmentId)?.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.score ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.max}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.score === null ? "—" : `${percent(r.score, r.max)}%`}</TableCell>
                        <TableCell className="pr-4">
                          <StatusBadge status={r.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pagination {...pager} />
              </>
            )}
          </div>
        </>
      ) : null}

      {tab === "Batch Performance" ? (
        <div className="rounded-lg border bg-card">
          {batchRows.length === 0 ? (
            <EmptyState className="m-4" title="No batch results for these filters" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Batch</TableHead>
                  <TableHead className="text-right">Assessments</TableHead>
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="w-64">Average score</TableHead>
                  <TableHead className="pr-4 text-right">Pass rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batchRows.map(({ b, assessments, submitted, avg, pass }) => (
                  <TableRow key={b.id}>
                    <TableCell className="pl-4">
                      <Link href={`/admin/batches/${b.id}`} className="font-medium hover:underline">
                        {b.label}
                      </Link>
                      <div className="text-xs text-muted-foreground">{lookup.course(b.courseId)?.name}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{assessments}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(submitted)}</TableCell>
                    <TableCell>
                      {avg === null ? (
                        <span className="text-sm text-muted-foreground">Pending evaluation</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Progress value={avg} className="flex-1" />
                          <span className="w-12 text-right text-sm tabular-nums">{avg.toFixed(1)}%</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{pass === null ? "—" : `${pass}%`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : null}

      {tab === "Learner Performance" ? (
        <div className="rounded-lg border bg-card">
          {learnerRows.length === 0 ? (
            <EmptyState className="m-4" title="No learner results for these filters" />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Learner</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">Assessments taken</TableHead>
                    <TableHead className="pr-4 text-right">Average score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {learnerPager.slice.map((r) => {
                    const l = lookup.learner(r.id);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="pl-4 font-medium">{l?.name}</TableCell>
                        <TableCell className="text-muted-foreground">{lookup.batch(l?.batchId ?? "")?.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                        <TableCell className="pr-4 text-right tabular-nums">{r.avg === null ? "Pending" : `${r.avg.toFixed(1)}%`}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <Pagination {...learnerPager} />
            </>
          )}
        </div>
      ) : null}

      {tab === "Examiner Evaluation" ? (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Examiner</TableHead>
                <TableHead className="text-right">Scripts assigned</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="w-56 pr-4">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {examinerRows.map(({ e, total, pending, done }) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-4">
                    <Link href={`/admin/examiners/${e.id}`} className="font-medium hover:underline">
                      {e.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{e.specialization}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{total}</TableCell>
                  <TableCell className="text-right tabular-nums">{pending}</TableCell>
                  <TableCell className="text-right tabular-nums">{done}</TableCell>
                  <TableCell className="pr-4">
                    {total ? (
                      <div className="flex items-center gap-2">
                        <Progress value={percent(done, total)} className="flex-1" />
                        <span className="w-10 text-right text-sm tabular-nums">{Math.round(percent(done, total))}%</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">No scripts</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
}

export default withSuspense(ResultsPage);
