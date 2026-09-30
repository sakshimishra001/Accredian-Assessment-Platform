"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Activity, BarChart3, CalendarClock, Copy, Eye, Pencil, Play, Plus, Send, ShieldAlert, SquareCheckBig, Square, UserPlus, Users } from "lucide-react";
import { cn } from "cn";
import { useAssessmentActions, EDITABLE_STATUSES } from "@/components/proto/assessment-actions";
import { ConfirmDialog, Pagination, SearchInput, usePagination } from "@/components/proto/controls";
import { DetailList, EmptyState, MetricCard, PageHeader, Panel, PrototypeNote } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { QuestionView } from "@/components/proto/question-view";
import { StatusBadge } from "@/components/proto/status-badge";
import { withSuspense } from "@/components/proto/suspense-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime, formatDuration, formatNumber, percent } from "@/prototype/lib/format";
import { paperTotals, sectionQuestions } from "@/prototype/lib/paper";
import { useLookups, useProto, useProtoActions } from "@/prototype/store";
import { useToast } from "@/prototype/toast";
import type { Assessment, AssessmentStatus } from "@/prototype/types";

const TABS = ["overview", "paper", "batch", "examiners", "monitor", "results"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  paper: "Question Paper",
  batch: "Batch & Learners",
  examiners: "Examiners",
  monitor: "Monitor",
  results: "Results",
};

const NEXT_ACTION: Partial<Record<AssessmentStatus, { to: AssessmentStatus; label: string; confirm: string; icon: typeof Play }>> = {
  Scheduled: { to: "Active", label: "Start now", confirm: "Open the assessment for learners immediately, ahead of the scheduled time?", icon: Play },
  Active: { to: "Completed", label: "End assessment", confirm: "Close the assessment now? Learners still in progress will be auto-submitted.", icon: Square },
  Completed: { to: "Evaluation", label: "Start evaluation", confirm: "Release subjective answers to the assigned examiners?", icon: SquareCheckBig },
  Evaluation: { to: "Published", label: "Publish results", confirm: "Publish results? Learners in the batch will be able to see their scores.", icon: Send },
};

function AssessmentOverview() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const lookup = useLookups();
  const { updateAssessment } = useProtoActions();
  const { duplicate } = useAssessmentActions();
  const a = lookup.assessment(id);
  const initialTab = (TABS.find((t) => t === params.get("tab")) ?? "overview") as Tab;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [confirm, setConfirm] = useState<null | "next" | "unschedule">(null);

  if (!a) {
    return (
      <EmptyState
        className="mt-10"
        title="Assessment not found"
        description="It may have been created in a previous session — prototype data resets when the page is refreshed."
        action={<Link href="/admin/assessments" className={buttonVariants()}>Back to assessments</Link>}
      />
    );
  }

  const paper = lookup.paper(a.paperId);
  const batch = lookup.batch(a.batchId)!;
  const course = lookup.course(a.courseId);
  const next = NEXT_ACTION[a.status];

  const changeStatus = (to: AssessmentStatus, message: string) => {
    updateAssessment(a.id, { status: to, attempted: to === "Active" && a.attempted === 0 ? 0 : a.attempted });
    toast.success(message);
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, { label: a.name }]}
        title={a.name}
        meta={<StatusBadge status={a.status} />}
        description={`${course?.name} · ${batch.label} · ${formatDateTime(a.schedule.start)} IST`}
        actions={
          <>
            <Button variant="outline" onClick={() => { const c = duplicate(a); router.push(`/admin/assessments/${c.id}`); }}>
              <Copy /> Duplicate
            </Button>
            {EDITABLE_STATUSES.includes(a.status) ? (
              <Link href={`/admin/assessments/new?edit=${a.id}`} className={buttonVariants({ variant: "outline" })}>
                <Pencil /> Edit
              </Link>
            ) : null}
            {a.status === "Draft" ? (
              <Link href={`/admin/assessments/new?edit=${a.id}&step=${a.paperId ? 3 : 1}`} className={buttonVariants()}>
                <CalendarClock /> Continue setup
              </Link>
            ) : null}
            {a.status === "Scheduled" ? (
              <Button variant="outline" onClick={() => setConfirm("unschedule")}>
                Move to draft
              </Button>
            ) : null}
            {next ? (
              <Button onClick={() => setConfirm("next")}>
                <next.icon /> {next.label}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
              tab === t ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab a={a} onTab={setTab} /> : null}

      {tab === "paper" ? (
        paper ? (
          <div className="grid gap-6">
            <Panel
              title={paper.name}
              description={`${paper.subject} · ${paper.version} · ${paper.source} import`}
              actions={
                <Link href={`/admin/import-questions/${paper.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open in library
                </Link>
              }
            >
              <PaperStats paper={paper} />
              <PaperStructure paper={paper} className="mt-4" />
            </Panel>
            {paper.sections.map((s) => (
              <Panel key={s.id} title={s.name} description={`${s.range} · ${s.marks} marks`}>
                <div className="grid gap-6">
                  {sectionQuestions(paper, s.id).map((q) => (
                    <QuestionView key={q.id} q={q} />
                  ))}
                </div>
              </Panel>
            ))}
          </div>
        ) : (
          <EmptyState title="No question paper selected" action={<Link href={`/admin/assessments/new?edit=${a.id}&step=1`} className={buttonVariants()}>Select Question Paper</Link>} />
        )
      ) : null}

      {tab === "batch" ? <BatchTab a={a} /> : null}
      {tab === "examiners" ? <ExaminersTab a={a} /> : null}

      {tab === "monitor" ? (
        a.status === "Active" ? (
          <div className="grid gap-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label="In progress" value={Math.round(a.attempted * 0.4)} />
              <MetricCard label="Submitted" value={Math.round(a.attempted * 0.6)} />
              <MetricCard label="Not started" value={batch.learnerIds.length - a.attempted} />
              <MetricCard label="Connection issues" value={2} tone="attention" hint="Auto-resume enabled" />
            </div>
            <Panel title="Live monitoring" description="Real-time attempt tracking arrives with the attempt engine.">
              <PrototypeNote>Prototype — live monitoring values are simulated.</PrototypeNote>
              <div className="mt-4 grid gap-2">
                <div className="flex justify-between text-sm">
                  <span>Batch participation</span>
                  <span className="tabular-nums">{percent(a.attempted, batch.learnerIds.length)}%</span>
                </div>
                <Progress value={percent(a.attempted, batch.learnerIds.length)} />
              </div>
            </Panel>
          </div>
        ) : (
          <EmptyState
            icon={Activity}
            title={a.status === "Scheduled" || a.status === "Draft" ? "Monitoring starts when the assessment goes live" : "This assessment is no longer live"}
            description={a.status === "Scheduled" ? `Opens ${formatDateTime(a.schedule.start)} IST.` : "See the Results tab for outcomes."}
          />
        )
      ) : null}

      {tab === "results" ? <ResultsTab a={a} /> : null}

      <ConfirmDialog
        open={confirm === "next"}
        onOpenChange={(o) => setConfirm(o ? "next" : null)}
        title={next ? `${next.label}?` : ""}
        description={next?.confirm}
        confirmLabel={next?.label}
        onConfirm={() => next && changeStatus(next.to, `Assessment moved to ${next.to}`)}
      />
      <ConfirmDialog
        open={confirm === "unschedule"}
        onOpenChange={(o) => setConfirm(o ? "unschedule" : null)}
        title="Move back to draft?"
        description="Learners will no longer see this assessment until it is scheduled again."
        confirmLabel="Move to draft"
        onConfirm={() => changeStatus("Draft", "Assessment moved back to draft")}
      />
    </>
  );
}

function OverviewTab({ a, onTab }: { a: Assessment; onTab: (t: Tab) => void }) {
  const lookup = useLookups();
  const state = useProto();
  const paper = lookup.paper(a.paperId);
  const batch = lookup.batch(a.batchId)!;
  const totals = paper ? paperTotals(paper) : null;
  const evals = state.evaluations.filter((e) => e.assessmentId === a.id);
  const learnerCount = batch.learnerIds.length;

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Learners" value={formatNumber(learnerCount)} hint={batch.label} />
        <MetricCard label="Attempted" value={formatNumber(a.attempted)} hint={`${percent(a.attempted, learnerCount)}% of batch`} />
        <MetricCard label="Maximum marks" value={totals?.marks ?? "—"} hint={paper ? `${totals?.questions} questions` : "No paper"} />
        <MetricCard label="Duration" value={formatDuration(a.durationMinutes)} hint={`${a.maxAttempts} attempt${a.maxAttempts === 1 ? "" : "s"}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Details">
          <DetailList
            items={[
              ["Type", a.type],
              ["Course", lookup.course(a.courseId)?.name],
              ["Batch", <button key="b" type="button" className="text-primary hover:underline" onClick={() => onTab("batch")}>{batch.name}</button>],
              ["Question paper", paper ? <button key="p" type="button" className="text-left text-primary hover:underline" onClick={() => onTab("paper")}>{paper.name}</button> : "Not selected"],
              ["Description", a.description || "—"],
              ["Created", formatDate(a.createdAt)],
            ]}
          />
        </Panel>
        <Panel title="Schedule & rules">
          <DetailList
            items={[
              ["Opens", `${formatDateTime(a.schedule.start)} IST`],
              ["Closes", `${formatDateTime(a.schedule.end)} IST`],
              ["Negative marking", a.negativeMarking ? `−${a.negativeMarks} per wrong objective answer` : "Disabled"],
              ["Randomize", [a.settings.randomizeQuestions && "Questions", a.settings.randomizeOptions && "Options"].filter(Boolean).join(", ") || "Off"],
              ["Results", a.settings.showResultsImmediately ? "Immediately after submission" : "When published"],
              ["Resume", a.settings.allowResume ? "Allowed" : "Not allowed"],
              [
                "Proctoring",
                a.settings.proctoring ? (
                  <span key="pr" className="inline-flex items-center gap-1 text-amber-700">
                    <ShieldAlert className="size-3.5" /> Enabled · provider not configured
                  </span>
                ) : (
                  "Disabled"
                ),
              ],
              ["Notifications", [a.schedule.notifyLearners && "Email on publish", a.schedule.sendReminder && "Reminder"].filter(Boolean).join(" · ") || "None"],
            ]}
          />
        </Panel>
      </div>

      {paper ? (
        <Panel title="Question structure" actions={<Button variant="ghost" size="sm" onClick={() => onTab("paper")}><Eye /> View paper</Button>}>
          <PaperStructure paper={paper} />
        </Panel>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Examiners" actions={<Button variant="ghost" size="sm" onClick={() => onTab("examiners")}><UserPlus /> Assign</Button>}>
          {a.examinerIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">{a.type === "Objective" ? "Objective assessments are scored automatically." : "No examiners assigned yet."}</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {a.examinerIds.map((eid) => {
                const ex = lookup.examiner(eid);
                const mine = evals.filter((e) => e.examinerId === eid);
                return (
                  <li key={eid} className="flex items-center justify-between">
                    <Link href={`/admin/examiners/${eid}`} className="hover:underline">
                      {ex?.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {mine.filter((e) => e.status === "Completed").length}/{mine.length} scripts evaluated
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Results" actions={<Button variant="ghost" size="sm" onClick={() => onTab("results")}><BarChart3 /> Open</Button>}>
          <p className="text-sm text-muted-foreground">
            {a.status === "Published"
              ? "Results are published and visible to learners."
              : ["Completed", "Evaluation"].includes(a.status)
                ? "Awaiting evaluation before results can be published."
                : "Results will be available after the assessment ends."}
          </p>
        </Panel>
      </div>
    </div>
  );
}

function BatchTab({ a }: { a: Assessment }) {
  const state = useProto();
  const lookup = useLookups();
  const batch = lookup.batch(a.batchId)!;
  const [q, setQ] = useState("");
  const rows = useMemo(
    () =>
      state.learners
        .filter((l) => l.batchId === batch.id)
        .filter((l) => (q.trim() ? `${l.name} ${l.email}`.toLowerCase().includes(q.trim().toLowerCase()) : true)),
    [state.learners, batch.id, q],
  );
  const pager = usePagination(rows, 10);
  return (
    <Panel
      title={batch.name}
      description={`${formatNumber(batch.learnerIds.length)} learners · created ${formatDate(batch.createdAt)}`}
      actions={
        <Link href={`/admin/batches/${batch.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <Users /> Open batch
        </Link>
      }
      bodyClassName="p-0"
    >
      <div className="p-4">
        <SearchInput value={q} onChange={setQ} placeholder="Search learners…" className="max-w-sm" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="pr-4">Assessment</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pager.slice.map((l, i) => {
            const index = batch.learnerIds.indexOf(l.id);
            const attempted = index < a.attempted;
            return (
              <TableRow key={l.id}>
                <TableCell className="pl-4 font-medium">{l.name}</TableCell>
                <TableCell className="text-muted-foreground">{l.email}</TableCell>
                <TableCell>
                  <StatusBadge status={l.status} />
                </TableCell>
                <TableCell className="pr-4 text-muted-foreground">
                  {a.status === "Scheduled" || a.status === "Draft" ? "Not started" : attempted ? (a.status === "Active" && i % 3 === 0 ? "In progress" : "Submitted") : "Not attempted"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Pagination {...pager} />
    </Panel>
  );
}

function ExaminersTab({ a }: { a: Assessment }) {
  const state = useProto();
  const lookup = useLookups();
  const toast = useToast();
  const { updateAssessment } = useProtoActions();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(a.examinerIds);
  const evals = state.evaluations.filter((e) => e.assessmentId === a.id);
  const paper = lookup.paper(a.paperId);
  const subjective = paper ? paperTotals(paper).subjective : 0;

  return (
    <>
      <Panel
        title="Examiner assignment"
        description={subjective ? `${subjective} subjective question${subjective === 1 ? "" : "s"} need manual evaluation.` : "This paper has no subjective questions; scoring is automatic."}
        actions={
          <Button size="sm" onClick={() => { setPicked(a.examinerIds); setOpen(true); }}>
            <Plus /> Assign examiners
          </Button>
        }
        bodyClassName="p-0"
      >
        {a.examinerIds.length === 0 ? (
          <EmptyState className="m-4" icon={UserPlus} title="No examiners assigned" description="Assign examiners to evaluate subjective answers after the assessment ends." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Examiner</TableHead>
                <TableHead>Specialization</TableHead>
                <TableHead>Assigned scripts</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.examinerIds.map((eid) => {
                const ex = lookup.examiner(eid);
                const mine = evals.filter((e) => e.examinerId === eid);
                return (
                  <TableRow key={eid}>
                    <TableCell className="pl-4">
                      <Link href={`/admin/examiners/${eid}`} className="font-medium hover:underline">
                        {ex?.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{ex?.email}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{ex?.specialization}</TableCell>
                    <TableCell className="tabular-nums">{mine.length || "Assigned on evaluation start"}</TableCell>
                    <TableCell className="tabular-nums">{mine.filter((e) => e.status === "Completed").length}</TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge status={ex?.status ?? "Active"} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign examiners</DialogTitle>
            <DialogDescription>Scripts are distributed evenly between the selected examiners when evaluation starts.</DialogDescription>
          </DialogHeader>
          <ul className="grid max-h-80 gap-1 overflow-auto">
            {state.examiners
              .filter((e) => e.status !== "Inactive")
              .map((e) => (
                <li key={e.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">
                    <Checkbox checked={picked.includes(e.id)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, e.id] : p.filter((x) => x !== e.id)))} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{e.name}</span>
                      <span className="block text-xs text-muted-foreground">{e.specialization}</span>
                    </span>
                    <StatusBadge status={e.status} />
                  </label>
                </li>
              ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                updateAssessment(a.id, { examinerIds: picked });
                setOpen(false);
                toast.success("Examiners updated", `${picked.length} examiner${picked.length === 1 ? "" : "s"} assigned to ${a.name}.`);
              }}
            >
              Save assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ResultsTab({ a }: { a: Assessment }) {
  const state = useProto();
  const lookup = useLookups();
  const rows = state.results.filter((r) => r.assessmentId === a.id);
  const pager = usePagination(rows, 10);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No results yet"
        description={a.status === "Active" ? "Results appear once the assessment ends and scoring is complete." : "Results will be available after the assessment has been taken."}
      />
    );
  }
  const scored = rows.filter((r) => r.score !== null);
  const avg = scored.length ? scored.reduce((s, r) => s + (r.score ?? 0), 0) / scored.length : 0;
  const passRate = scored.length ? percent(rows.filter((r) => r.status === "Passed").length, scored.length) : 0;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Submitted" value={rows.filter((r) => r.status !== "Absent").length} />
        <MetricCard label="Average score" value={scored.length ? `${avg.toFixed(1)} / ${rows[0].max}` : "Pending"} />
        <MetricCard label="Pass rate" value={scored.length ? `${passRate}%` : "Pending"} />
        <MetricCard label="Pending evaluation" value={rows.filter((r) => r.status === "Pending evaluation").length} tone="attention" />
      </div>
      <Panel title="Learner results" bodyClassName="p-0" actions={<Link href={`/admin/results?assessment=${a.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Open in reports</Link>}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Learner</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Percentage</TableHead>
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
                <TableCell className="tabular-nums">{r.score === null ? "—" : `${r.score} / ${r.max}`}</TableCell>
                <TableCell className="tabular-nums">{r.score === null ? "—" : `${percent(r.score, r.max)}%`}</TableCell>
                <TableCell className="pr-4">
                  <StatusBadge status={r.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pagination {...pager} />
      </Panel>
    </div>
  );
}

export default withSuspense(AssessmentOverview);
