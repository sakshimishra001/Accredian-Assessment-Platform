"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ClipboardList, Eye, Pencil, Plus, Settings2, X } from "lucide-react";
import { cn } from "cn";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions, type RowAction } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL, STATUS_ORDER, type AssessmentStatus } from "@/lib/assessments/lifecycle";
import { ASSESSMENT_TYPE_LABEL } from "@/lib/validation/assessment";
import { formatDate, formatDuration, formatTime } from "@/prototype/lib/format";
import type { listAssessments } from "@/server/services/assessments";

type Row = Awaited<ReturnType<typeof listAssessments>>["rows"][number];
type Tab = "ALL" | AssessmentStatus;

const TABS: Tab[] = ["ALL", ...STATUS_ORDER];
const DAY = 86_400_000;
const DATE_FILTERS = [
  { value: "past", label: "Past" },
  { value: "today", label: "Next 24 hours" },
  { value: "next7", label: "Next 7 days" },
  { value: "next30", label: "Next 30 days" },
];
/** Statuses whose settings can still be edited in the builder (see the lifecycle edit policy). */
const BUILDER_EDITABLE: AssessmentStatus[] = ["DRAFT", "SCHEDULED"];

export function AssessmentsView({
  rows: all,
  courses,
  batches,
  initialTab,
  now,
}: {
  rows: Row[];
  courses: { id: string; name: string }[];
  batches: { id: string; name: string; courseId: string }[];
  initialTab?: string;
  /** Server time when the page was rendered, so date filters match on server and client. */
  now: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t === initialTab?.toUpperCase()) ?? "ALL");
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [batch, setBatch] = useState("");
  const [type, setType] = useState("");
  const [date, setDate] = useState("");

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all
      .filter((a) => (tab === "ALL" ? a.status !== "ARCHIVED" : a.status === tab))
      .filter((a) => (course ? a.courseId === course : true))
      .filter((a) => (batch ? a.batch?.id === batch : true))
      .filter((a) => (type ? a.type === type : true))
      .filter((a) => {
        if (!date) return true;
        const t = a.startAt.getTime();
        if (date === "past") return t < now;
        const span = date === "today" ? DAY : date === "next7" ? 7 * DAY : 30 * DAY;
        return t >= now && t < now + span;
      })
      .filter((a) => !term || a.name.toLowerCase().includes(term) || (a.paper?.name.toLowerCase().includes(term) ?? false));
  }, [all, tab, course, batch, type, date, q, now]);

  const pager = usePagination(rows, 10);
  const filtersActive = Boolean(q || course || batch || type || date);
  const count = (t: Tab) => (t === "ALL" ? all.filter((a) => a.status !== "ARCHIVED").length : all.filter((a) => a.status === t).length);
  const clear = () => {
    setQ("");
    setCourse("");
    setBatch("");
    setType("");
    setDate("");
  };

  const actionsFor = (a: Row): RowAction[] => [
    { label: "View", icon: Eye, onSelect: () => router.push(`/admin/assessments/${a.id}`) },
    ...(BUILDER_EDITABLE.includes(a.status) ? [{ label: "Edit", icon: Pencil, onSelect: () => router.push(`/admin/assessments/new?edit=${a.id}`) }] : []),
    ...(a.status === "DRAFT" ? [{ label: "Continue setup", icon: Settings2, onSelect: () => router.push(`/admin/assessments/new?edit=${a.id}&step=${a.paper ? 5 : 1}`) }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Assessments"
        description="Create, schedule and manage learner assessments."
        actions={
          <Link href="/admin/assessments/new" className={buttonVariants()}>
            <Plus /> Create Assessment
          </Link>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="Assessment status">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              pager.setPage(1);
            }}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap",
              tab === t ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "ALL" ? "All" : STATUS_LABEL[t]}
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{count(t)}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_repeat(4,minmax(0,10rem))_auto]">
        <SearchInput value={q} onChange={setQ} placeholder="Search assessments or papers…" />
        <SelectField
          value={course}
          onChange={(v) => {
            setCourse(v);
            setBatch("");
          }}
          placeholder="All courses"
          ariaLabel="Course"
          options={courses.map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectField value={batch} onChange={setBatch} placeholder="All batches" ariaLabel="Batch" options={batches.filter((b) => !course || b.courseId === course).map((b) => ({ value: b.id, label: b.name }))} />
        <SelectField value={type} onChange={setType} placeholder="All types" ariaLabel="Assessment type" options={Object.entries(ASSESSMENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <SelectField value={date} onChange={setDate} placeholder="Any date" ariaLabel="Date" options={DATE_FILTERS} />
        {filtersActive ? (
          <Button variant="ghost" onClick={clear}>
            <X /> Clear
          </Button>
        ) : (
          <span className="hidden lg:block" />
        )}
      </div>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={ClipboardList}
            title={filtersActive || tab !== "ALL" ? "No assessments match your filters" : "No assessments yet"}
            description={filtersActive ? "Try clearing a filter." : "Create an assessment from a question paper."}
            action={
              filtersActive ? (
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              ) : (
                <Link href="/admin/assessments/new" className={buttonVariants()}>
                  Create Assessment
                </Link>
              )
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Assessment Name</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>Question Paper</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Scheduled Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.slice.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/admin/assessments/${a.id}`)}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {ASSESSMENT_TYPE_LABEL[a.type]} · {a.questionCount} questions
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.course.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.batch?.name ?? <span className="italic">Not selected</span>}</TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">{a.paper ? `${a.paper.name} · v${a.paper.version}` : <span className="italic">Not selected</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDuration(a.durationMinutes)}</TableCell>
                    <TableCell>
                      <div>{formatDate(a.startAt.toISOString())}</div>
                      <div className="text-xs text-muted-foreground">{formatTime(a.startAt.toISOString())} IST</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={STATUS_LABEL[a.status]} />
                    </TableCell>
                    <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActions actions={actionsFor(a)} label={`Actions for ${a.name}`} />
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
  );
}
