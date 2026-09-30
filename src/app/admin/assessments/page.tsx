"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ClipboardList, Plus, X } from "lucide-react";
import { cn } from "cn";
import { useAssessmentActions } from "@/components/proto/assessment-actions";
import { Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { EmptyState, PageHeader } from "@/components/proto/page";
import { RowActions } from "@/components/proto/row-actions";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDuration, formatTime } from "@/prototype/lib/format";
import { DEMO_DAY_START } from "@/prototype/lib/random";
import { useLookups, useProto } from "@/prototype/store";
import type { AssessmentStatus } from "@/prototype/types";

const TABS: ("All" | AssessmentStatus)[] = ["All", "Draft", "Scheduled", "Active", "Completed", "Evaluation", "Published"];
const DATE_FILTERS = [
  { value: "past", label: "Past" },
  { value: "today", label: "Today" },
  { value: "next7", label: "Next 7 days" },
  { value: "next30", label: "Next 30 days" },
];

function AssessmentsPage() {
  const s = useProto();
  const lookup = useLookups();
  const router = useRouter();
  const params = useSearchParams();
  const { rowActions } = useAssessmentActions();
  const initialTab = TABS.find((t) => t === params.get("tab")) ?? "All";
  const [tab, setTab] = useState<(typeof TABS)[number]>(initialTab);
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [batch, setBatch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");

  const rows = useMemo(() => {
    const dayStart = DEMO_DAY_START;
    const dayEnd = DEMO_DAY_START + 86400000;
    return s.assessments
      .filter((a) => (tab === "All" ? true : a.status === tab))
      .filter((a) => (status ? a.status === status : true))
      .filter((a) => (course ? a.courseId === course : true))
      .filter((a) => (batch ? a.batchId === batch : true))
      .filter((a) => (type ? a.type === type : true))
      .filter((a) => {
        if (!date) return true;
        const t = new Date(a.schedule.start).getTime();
        if (date === "past") return t < dayStart;
        if (date === "today") return t >= dayStart && t < dayEnd;
        if (date === "next7") return t >= dayStart && t < dayStart + 7 * 86400000;
        return t >= dayStart && t < dayStart + 30 * 86400000;
      })
      .filter((a) => {
        const term = q.trim().toLowerCase();
        if (!term) return true;
        const p = lookup.paper(a.paperId);
        return a.name.toLowerCase().includes(term) || (p?.name.toLowerCase().includes(term) ?? false);
      })
      .sort((a, b) => b.schedule.start.localeCompare(a.schedule.start));
  }, [s.assessments, tab, status, course, batch, type, date, q, lookup]);

  const pager = usePagination(rows, 10);
  const filtersActive = Boolean(q || course || batch || type || status || date);
  const counts = (t: (typeof TABS)[number]) => (t === "All" ? s.assessments.length : s.assessments.filter((a) => a.status === t).length);

  const clear = () => {
    setQ("");
    setCourse("");
    setBatch("");
    setType("");
    setStatus("");
    setDate("");
  };

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
            {t}
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground tabular-nums">{counts(t)}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_repeat(5,minmax(0,10rem))_auto]">
        <SearchInput value={q} onChange={setQ} placeholder="Search assessments or papers…" />
        <SelectField value={course} onChange={setCourse} placeholder="All courses" ariaLabel="Course" options={s.courses.map((c) => ({ value: c.id, label: c.name }))} />
        <SelectField
          value={batch}
          onChange={setBatch}
          placeholder="All batches"
          ariaLabel="Batch"
          options={s.batches.filter((b) => !course || b.courseId === course).map((b) => ({ value: b.id, label: b.label }))}
        />
        <SelectField value={type} onChange={setType} placeholder="All types" ariaLabel="Assessment type" options={["Objective", "Subjective", "Mixed"].map((v) => ({ value: v, label: v }))} />
        <SelectField value={status} onChange={setStatus} placeholder="Any status" ariaLabel="Status" options={TABS.slice(1).map((v) => ({ value: v, label: v }))} />
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
            title={filtersActive || tab !== "All" ? "No assessments match your filters" : "No assessments yet"}
            description={filtersActive ? "Try clearing a filter." : "Create an assessment from an approved question paper."}
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
                {pager.slice.map((a) => {
                  const paper = lookup.paper(a.paperId);
                  return (
                    <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/admin/assessments/${a.id}`)}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">{a.type}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{lookup.course(a.courseId)?.name}</TableCell>
                      <TableCell className="text-muted-foreground">{lookup.batch(a.batchId)?.label}</TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">{paper ? paper.name : <span className="italic">Not selected</span>}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDuration(a.durationMinutes)}</TableCell>
                      <TableCell>
                        <div>{formatDate(a.schedule.start)}</div>
                        <div className="text-xs text-muted-foreground">{formatTime(a.schedule.start)} IST</div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <RowActions actions={rowActions(a)} label={`Actions for ${a.name}`} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pagination {...pager} />
          </>
        )}
      </div>
    </>
  );
}

export default withSuspense(AssessmentsPage);
