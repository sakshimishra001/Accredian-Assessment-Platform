"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, BarChart3, CalendarClock, Eye, KeyRound, Pencil, Send, ShieldCheck, SquareCheckBig, Trash2, Undo2, UserPlus, Users } from "lucide-react";
import { cn } from "cn";
import { PaperQuestions } from "@/components/papers/paper-questions";
import { ConfirmDialog, Pagination, SearchInput, SelectField, usePagination } from "@/components/proto/controls";
import { DetailList, EmptyState, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { PaperStats, PaperStructure } from "@/components/proto/paper-summary";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { proctoringSummary } from "@/lib/proctoring/summary";
import { ASSESSMENT_TYPE_LABEL, RESULT_VISIBILITY_LABEL } from "@/lib/validation/assessment";
import { formatDate, formatDateTime, formatDuration, formatNumber } from "@/prototype/lib/format";
import type { QuestionPaper } from "@/prototype/types";
import { useToast } from "@/prototype/toast";
import { archiveAssessmentAction, assignProctorAction, issueLearnerPasswordsAction, moveAssessmentToDraftAction, unassignProctorAction } from "@/server/actions/assessments";
import { assignExaminerAction, moveAssessmentAction } from "@/server/actions/results";
import type { AssessmentDetail } from "@/server/services/assessments";
import { LiveControl, type LiveState } from "./live-control";

export type DetailTab = "overview" | "paper" | "learners" | "proctors";
const TAB_LABEL: Record<DetailTab, string> = { overview: "Overview", paper: "Question Paper", learners: "Batch & Learners", proctors: "Proctors" };

const RESULT_DETAIL_LABEL: Record<AssessmentDetail["resultDetail"], string> = {
  SCORE: "Score only",
  SCORE_AND_ANSWERS: "Score and answers",
  FULL_FEEDBACK: "Score, answers and feedback",
};

interface Candidate {
  id: string;
  name: string;
  email: string;
  status: string;
  assignedAt: Date;
  /** The learner's own password (one for all their assessments): whether it is set — never the password. */
  password: { set: boolean; lastLoginAt: Date | null };
  /** The examiner who evaluates this candidate for this assessment. */
  examiner: { id: string; name: string } | null;
}
export interface ExaminerOption {
  id: string;
  name: string;
  email: string;
}
/** An assigned proctor (staff role REVIEWER, shown as "Proctor"). */
export interface AssignedProctor {
  id: string;
  name: string;
  email: string;
  status: string;
  assignedAt: Date;
  assignedBy: string;
}
export interface ProctorOption {
  id: string;
  name: string;
  email: string;
}

/** Statuses in which learner passwords are handed out from this screen. */
const ISSUABLE = ["SCHEDULED", "ACTIVE", "PAUSED"];
type Issued = { name: string; email: string; password: string };
interface Learner {
  id: string;
  name: string;
  email: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** The manual lifecycle moves this screen offers (publishing is done in the builder). */
const OFFERED = ["DRAFT", "ARCHIVED", "ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED"] as const;
type Move = (typeof OFFERED)[number];
const MOVE_CONFIRM: Record<Move, { title: string; destructive?: boolean }> = {
  DRAFT: { title: "Move back to draft?" },
  ARCHIVED: { title: "Archive this assessment?", destructive: true },
  ENDED: { title: "End the assessment now?", destructive: true },
  EVALUATION: { title: "" },
  RESULT_READY: { title: "" },
  PUBLISHED: { title: "Publish results to learners?" },
};

export function AssessmentDetailView({
  assessment: a,
  live,
  paper,
  candidates,
  batchLearners,
  examiners,
  proctors,
  proctorOptions,
  initialTab,
}: {
  assessment: AssessmentDetail;
  /** Live-control state while the assessment is live (ACTIVE) or paused; otherwise null. */
  live: LiveState | null;
  paper: QuestionPaper | null;
  candidates: Candidate[];
  batchLearners: Learner[];
  /** Active examiner accounts (for assignment). */
  examiners: ExaminerOption[];
  /** Proctors assigned to this assessment, and the active proctor accounts that can be assigned. */
  proctors: AssignedProctor[];
  proctorOptions: ProctorOption[];
  initialTab: DetailTab;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [confirm, setConfirm] = useState<Move | null>(null);
  const [pending, startTransition] = useTransition();
  const actions = a.actions.filter((t) => (OFFERED as readonly string[]).includes(t.to));
  const confirmAction = actions.find((t) => t.to === confirm);

  function run(to: Move) {
    startTransition(async () => {
      const result = to === "DRAFT" ? await moveAssessmentToDraftAction(a.id) : to === "ARCHIVED" ? await archiveAssessmentAction(a.id) : await moveAssessmentAction(a.id, to);
      if (!result.ok) return toast.error("That didn’t work", result.error);
      toast.success(`Assessment is now ${STATUS_LABEL[to].toLowerCase()}`);
      router.refresh();
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Assessments", href: "/admin/assessments" }, { label: a.name }]}
        title={a.name}
        meta={<StatusBadge status={STATUS_LABEL[a.status]} />}
        description={[a.course.name, a.batch?.name, `${formatDateTime(iso(a.startAt))} IST`].filter(Boolean).join(" · ")}
        actions={
          <>
            {actions.map((t) => (
              <Button
                key={t.to}
                variant={t.to === "DRAFT" || t.to === "ARCHIVED" || t.to === "ENDED" ? "outline" : "default"}
                onClick={() => setConfirm(t.to as Move)}
                disabled={pending || !t.check.ok}
                title={t.check.ok ? t.description : t.check.reasons.join(" ")}
              >
                {t.to === "DRAFT" ? <Undo2 /> : t.to === "ARCHIVED" ? <Archive /> : t.to === "PUBLISHED" ? <Send /> : <SquareCheckBig />} {t.to === "DRAFT" ? "Move to draft" : t.label}
              </Button>
            ))}
            {["ACTIVE", "PAUSED", "ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED", "ARCHIVED"].includes(a.status) ? (
              <Link href={`/admin/results/${a.id}`} className={buttonVariants({ variant: "outline" })}>
                <BarChart3 /> Results
              </Link>
            ) : null}
            {a.status === "DRAFT" || a.status === "SCHEDULED" ? (
              <Link href={`/admin/assessments/new?edit=${a.id}`} className={buttonVariants({ variant: "outline" })}>
                <Pencil /> Edit
              </Link>
            ) : null}
            {a.status === "DRAFT" ? (
              <Link href={`/admin/assessments/new?edit=${a.id}&step=${a.paper ? 5 : 1}`} className={buttonVariants()}>
                <CalendarClock /> Continue setup
              </Link>
            ) : null}
          </>
        }
      />

      {live ? <LiveControl assessmentId={a.id} assessmentName={a.name} live={live} /> : null}
      {a.status === "DRAFT" && a.publishIssues.length ? (
        <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">Not ready to publish: {a.publishIssues.join(" ")}</p>
      ) : null}
      {a.status === "SCHEDULED" ? (
        <p className="mb-5 rounded-lg bg-accent px-4 py-3 text-sm text-accent-foreground">
          Scheduled {formatDateTime(iso(a.scheduledAt))}. Opens automatically at {formatDateTime(iso(a.startAt))} IST and closes at {formatDateTime(iso(a.endAt))} IST.
        </p>
      ) : null}

      <div className="mb-5 flex gap-1 overflow-x-auto border-b" role="tablist">
        {(Object.keys(TAB_LABEL) as DetailTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap", tab === t ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab a={a} paper={paper} candidateCount={candidates.length} onTab={setTab} /> : null}

      {tab === "paper" ? (
        paper && a.paper ? (
          <div className="grid gap-6">
            <Panel
              title={a.paper.name}
              description={`v${a.paper.version} · questions are frozen in the assessment`}
              actions={
                <Link href={`/admin/import-questions/${a.paper.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open in library
                </Link>
              }
            >
              <PaperStats paper={paper} />
              <PaperStructure paper={paper} className="mt-4" />
            </Panel>
            <PaperQuestions paper={paper} />
          </div>
        ) : (
          <EmptyState title="No question paper selected" action={<Link href={`/admin/assessments/new?edit=${a.id}&step=1`} className={buttonVariants()}>Select Question Paper</Link>} />
        )
      ) : null}

      {tab === "learners" ? <LearnersTab a={a} candidates={candidates} batchLearners={batchLearners} examiners={examiners} /> : null}

      {tab === "proctors" ? <ProctorsTab a={a} proctors={proctors} options={proctorOptions} /> : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm ? (confirm === "EVALUATION" || confirm === "RESULT_READY" ? `${confirmAction?.label}?` : MOVE_CONFIRM[confirm].title) : ""}
        description={confirmAction?.description}
        confirmLabel={confirm === "DRAFT" ? "Move to draft" : (confirmAction?.label ?? "")}
        destructive={confirm ? MOVE_CONFIRM[confirm].destructive : false}
        onConfirm={() => confirm && run(confirm)}
      />
    </>
  );
}

function OverviewTab({ a, paper, candidateCount, onTab }: { a: AssessmentDetail; paper: QuestionPaper | null; candidateCount: number; onTab: (t: DetailTab) => void }) {
  const s = a.settings;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Candidates" value={formatNumber(candidateCount)} hint={a.status === "DRAFT" ? "Assigned on publish" : a.batch?.name} />
        <MetricCard label="Batch learners" value={formatNumber(a.batch?.learnerCount ?? 0)} hint={a.batch ? (a.batch.isActive ? "Active learners" : "Batch inactive") : "No batch"} />
        <MetricCard label="Maximum marks" value={a.paper ? a.totals.totalMarks : "—"} hint={a.paper ? `${a.totals.questionCount} questions` : "No paper"} />
        <MetricCard label="Duration" value={formatDuration(a.durationMinutes)} hint={`${a.maxAttempts} attempt${a.maxAttempts === 1 ? "" : "s"}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Details">
          <DetailList
            items={[
              ["Type", ASSESSMENT_TYPE_LABEL[a.type]],
              ["Course", `${a.course.name} (${a.course.code})`],
              ["Batch", a.batch ? <button key="b" type="button" className="text-primary hover:underline" onClick={() => onTab("learners")}>{a.batch.name}</button> : "Not selected"],
              ["Question paper", a.paper ? <button key="p" type="button" className="text-left text-primary hover:underline" onClick={() => onTab("paper")}>{`${a.paper.name} · v${a.paper.version}`}</button> : "Not selected"],
              ["Description", a.description || "—"],
              ["Instructions", <span key="i" className="whitespace-pre-line">{a.instructions || "—"}</span>],
              ["Created", `${formatDate(iso(a.createdAt))} by ${a.createdBy.name}`],
            ]}
          />
        </Panel>
        <Panel title="Schedule & rules">
          <DetailList
            items={[
              ["Opens", `${formatDateTime(iso(a.startAt))} IST`],
              ["Closes", `${formatDateTime(iso(a.endAt))} IST`],
              ["Timing", s.timingMode === "WINDOW" ? "Attempts end when the window closes" : "Full duration if started within the window"],
              ["Passing marks", `${a.passingMarks}${a.paper ? ` of ${a.totals.totalMarks}` : ""}`],
              ["Negative marking", s.negativeMarking ? "On (as set on the paper)" : "Off"],
              ["Randomize", [s.randomizeQuestions && "Questions", s.randomizeOptions && "Options"].filter(Boolean).join(", ") || "Off"],
              ["Learner experience", [s.allowResume && "Resume", s.showQuestionPalette && "Question palette", s.allowMarkForReview && "Mark for review"].filter(Boolean).join(", ") || "Minimal"],
              ["Learner tools", [s.calculatorEnabled && `${s.calculatorType === "SCIENTIFIC" ? "Scientific" : "Basic"} calculator`, s.spellCheckEnabled && "Spell check"].filter(Boolean).join(", ") || "None"],
              ["Results", `${RESULT_VISIBILITY_LABEL[a.resultVisibility]} · ${RESULT_DETAIL_LABEL[a.resultDetail]}`],
              ["Proctoring", proctoringSummary({ proctoringEnabled: a.proctoringEnabled, ...s })],
              ["Communication", "Not connected yet — no emails are sent"],
            ]}
          />
        </Panel>
      </div>

      {paper ? (
        <Panel title="Question structure" actions={<Button variant="ghost" size="sm" onClick={() => onTab("paper")}><Eye /> View paper</Button>}>
          <PaperStructure paper={paper} />
        </Panel>
      ) : null}
    </div>
  );
}

function LearnersTab({ a, candidates, batchLearners, examiners }: { a: AssessmentDetail; candidates: Candidate[]; batchLearners: Learner[]; examiners: ExaminerOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [confirmIssue, setConfirmIssue] = useState<null | "missing" | "reset">(null);
  const [issued, setIssued] = useState<Issued[] | null>(null);
  const [pending, startTransition] = useTransition();
  const canIssue = candidates.length > 0 && ISSUABLE.includes(a.status);
  const missing = candidates.filter((c) => !c.password.set).length;

  const canAssign = a.status !== "ARCHIVED" && a.type !== "OBJECTIVE";
  function assign(candidateId: string, examinerId: string) {
    startTransition(async () => {
      const result = await assignExaminerAction(a.id, [candidateId], examinerId || null);
      if (!result.ok) return toast.error("Couldn’t assign the examiner", result.error);
      toast.success(examinerId ? `Assigned to ${examiners.find((e) => e.id === examinerId)?.name}` : "Examiner unassigned");
      router.refresh();
    });
  }

  function issue(reset: boolean) {
    startTransition(async () => {
      const result = await issueLearnerPasswordsAction(a.id, reset);
      if (!result.ok) return toast.error("Couldn’t issue learner passwords", result.error);
      if (result.data!.length === 0) return toast.info("Nothing to issue", "Every candidate already has a learner password.");
      setIssued(result.data!);
      router.refresh();
    });
  }
  const assigned = candidates.length > 0;
  const term = q.trim().toLowerCase();
  const rows = (assigned ? candidates : batchLearners).filter((l) => !term || `${l.name} ${l.email}`.toLowerCase().includes(term));
  const pager = usePagination(rows, 10);

  if (!a.batch) return <EmptyState icon={Users} title="No batch selected" action={<Link href={`/admin/assessments/new?edit=${a.id}`} className={buttonVariants()}>Choose a batch</Link>} />;
  return (
    <Panel
      title={a.batch.name}
      description={
        assigned
          ? `${formatNumber(candidates.length)} candidates assigned to this assessment`
          : `${formatNumber(batchLearners.length)} active learners · they are assigned as candidates when the assessment is published`
      }
      actions={
        <>
          {canIssue && missing > 0 ? (
            <Button size="sm" onClick={() => setConfirmIssue("missing")} disabled={pending}>
              <KeyRound /> Issue learner passwords ({formatNumber(missing)})
            </Button>
          ) : null}
          {canIssue && missing < candidates.length ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmIssue("reset")} disabled={pending}>
              <KeyRound /> Reset all passwords
            </Button>
          ) : null}
          <Link href={`/admin/batches/${a.batch.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Users /> Open batch
          </Link>
        </>
      }
      bodyClassName="p-0"
    >
      <div className="p-4">
        <SearchInput value={q} onChange={setQ} placeholder="Search learners…" className="max-w-sm" />
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No learners.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className={assigned ? undefined : "pr-4"}>{assigned ? "Assigned" : "Status"}</TableHead>
                {assigned ? <TableHead>Learner password</TableHead> : null}
                {assigned ? <TableHead className="pr-4">Examiner</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pager.slice.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="pl-4 font-medium">{l.name}</TableCell>
                  <TableCell className="text-muted-foreground">{l.email}</TableCell>
                  <TableCell className={cn("text-muted-foreground", !assigned && "pr-4")}>{"assignedAt" in l ? formatDateTime(iso((l as Candidate).assignedAt)) : "Not assigned yet"}</TableCell>
                  {assigned ? (
                    <TableCell className="pr-4 text-muted-foreground">
                      {(l as Candidate).password.set ? (
                        <>
                          Set
                          {(l as Candidate).password.lastLoginAt ? <span className="block text-xs">Signed in {formatDateTime(iso((l as Candidate).password.lastLoginAt))}</span> : null}
                        </>
                      ) : (
                        "Not issued"
                      )}
                    </TableCell>
                  ) : null}
                  {assigned ? (
                    <TableCell className="pr-4">
                      {canAssign ? (
                        <SelectField
                          value={(l as Candidate).examiner?.id ?? ""}
                          onChange={(v) => assign(l.id, v)}
                          placeholder="Not assigned"
                          disabled={pending}
                          ariaLabel={`Examiner for ${l.name}`}
                          options={[
                            ...examiners.map((e) => ({ value: e.id, label: e.name })),
                            ...((l as Candidate).examiner && !examiners.some((e) => e.id === (l as Candidate).examiner!.id) ? [{ value: (l as Candidate).examiner!.id, label: `${(l as Candidate).examiner!.name} (inactive)` }] : []),
                          ]}
                        />
                      ) : (
                        <span className="text-muted-foreground">{a.type === "OBJECTIVE" ? "Scored automatically" : ((l as Candidate).examiner?.name ?? "—")}</span>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination {...pager} />
        </>
      )}

      <ConfirmDialog
        open={confirmIssue !== null}
        onOpenChange={(o) => !o && setConfirmIssue(null)}
        title={confirmIssue === "reset" ? "Reset all learner passwords?" : "Issue learner passwords?"}
        description={
          confirmIssue === "reset"
            ? `Every one of the ${candidates.length} candidates gets a new password. A learner’s password is used for all their assessments: their old one stops working everywhere and they are signed out.`
            : `${missing} candidate${missing === 1 ? "" : "s"} without a learner password will get one. Learners who already have one keep it. One password works for all of a learner’s assessments.`
        }
        confirmLabel={confirmIssue === "reset" ? "Reset passwords" : "Issue passwords"}
        destructive={confirmIssue === "reset"}
        onConfirm={() => issue(confirmIssue === "reset")}
      />
      <Dialog open={issued !== null} onOpenChange={(o) => !o && setIssued(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Learner passwords issued</DialogTitle>
            <DialogDescription>
              Shown only now — they are stored as hashes and can’t be displayed again. Give each learner their own password; they sign in at /learner/login with their email and it, for all their assessments.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Learner</th>
                  <th className="px-3 py-1.5 text-left font-medium">Password</th>
                </tr>
              </thead>
              <tbody>
                {(issued ?? []).map((c) => (
                  <tr key={c.email} className="border-t">
                    <td className="px-3 py-1.5">
                      {c.name}
                      <span className="block text-xs text-muted-foreground">{c.email}</span>
                    </td>
                    <td className="px-3 py-1.5 font-mono font-semibold tracking-wider" data-learner-password={c.email}>
                      {c.password}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

/**
 * Proctors of this assessment: existing staff accounts with the Proctor role. A proctor can monitor
 * only the assessments they are assigned to. The server checks everything (admin only, an active
 * proctor account, no duplicate) and records each change in the audit log.
 */
function ProctorsTab({ a, proctors, options }: { a: AssessmentDetail; proctors: AssignedProctor[]; options: ProctorOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pick, setPick] = useState("");
  const [removing, setRemoving] = useState<AssignedProctor | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = a.status !== "ARCHIVED";
  const available = options.filter((o) => !proctors.some((p) => p.id === o.id));

  function assign() {
    if (!pick) return;
    startTransition(async () => {
      const result = await assignProctorAction(a.id, pick);
      if (!result.ok) return toast.error("Couldn’t assign the proctor", result.error);
      toast.success(`${options.find((o) => o.id === pick)?.name ?? "Proctor"} can now proctor this assessment`);
      setPick("");
      router.refresh();
    });
  }

  function remove(p: AssignedProctor) {
    startTransition(async () => {
      const result = await unassignProctorAction(a.id, p.id);
      if (!result.ok) return toast.error("Couldn’t remove the proctor", result.error);
      toast.success(`${p.name} no longer proctors this assessment`);
      setRemoving(null);
      router.refresh();
    });
  }

  return (
    <Panel
      title="Proctors"
      description={`${formatNumber(proctors.length)} assigned · a proctor can access only the assessments they are assigned to`}
      bodyClassName="p-0"
    >
      {editable ? (
        <div className="flex flex-wrap items-end gap-3 border-b p-4">
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              There are no active proctor accounts. Add one in{" "}
              <Link href="/admin/users" className="text-primary hover:underline">
                Users
              </Link>{" "}
              with the Proctor role.
            </p>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every active proctor is already assigned.</p>
          ) : (
            <>
              <div className="w-full max-w-sm">
                <SelectField
                  value={pick}
                  onChange={setPick}
                  placeholder="Choose a proctor"
                  ariaLabel="Proctor to assign"
                  disabled={pending}
                  options={available.map((o) => ({ value: o.id, label: `${o.name} · ${o.email}` }))}
                />
              </div>
              <Button onClick={assign} disabled={!pick || pending}>
                <UserPlus /> Assign proctor
              </Button>
            </>
          )}
        </div>
      ) : null}
      {proctors.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={ShieldCheck} title="No proctors assigned" description="Assign a proctor to let them monitor this assessment." />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Assigned</TableHead>
              {editable ? <TableHead className="pr-4 text-right">Remove</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {proctors.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-4 font-medium">
                  {p.name}
                  {p.status !== "ACTIVE" ? <span className="ml-2 text-xs text-muted-foreground">(disabled)</span> : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{p.email}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(iso(p.assignedAt))}
                  <span className="block text-xs">by {p.assignedBy}</span>
                </TableCell>
                {editable ? (
                  <TableCell className="pr-4 text-right">
                    <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(p)} disabled={pending} aria-label={`Remove ${p.name} as proctor`}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this proctor"}?`}
        description="They will no longer be able to access this assessment. Their other assignments are unaffected."
        confirmLabel="Remove proctor"
        destructive
        onConfirm={() => removing && remove(removing)}
      />
    </Panel>
  );
}
