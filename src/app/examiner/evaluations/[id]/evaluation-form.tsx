"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Lock, Save, Send, XCircle } from "lucide-react";
import { cn } from "cn";
import { FileChip } from "@/components/files/file-preview";
import { ConfirmDialog } from "@/components/proto/controls";
import { DetailList, PageHeader, Panel } from "@/components/proto/page";
import { DownloadReportButton } from "@/components/reports/download-report-button";
import { StatusBadge } from "@/components/proto/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { formatDateTime } from "@/prototype/lib/format";
import { useToast } from "@/prototype/toast";
import { finalizeEvaluationAction, saveEvaluationAction } from "@/server/actions/evaluations";
import type { getEvaluation } from "@/server/services/evaluations";
import { EVALUATION_LABEL } from "../../evaluation-rows";

type Evaluation = Awaited<ReturnType<typeof getEvaluation>>;
type Question = Evaluation["questions"][number];
type Mark = { marks: string; comment: string };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const STATUS: Record<Question["status"], { label: string; className: string }> = {
  CORRECT: { label: "Correct", className: "text-emerald-700" },
  INCORRECT: { label: "Incorrect", className: "text-red-700" },
  PARTIALLY_CORRECT: { label: "Partially correct", className: "text-amber-700" },
  UNANSWERED: { label: "Unanswered", className: "text-muted-foreground" },
  EVALUATED: { label: "Evaluated", className: "text-sky-700" },
  PENDING_EVALUATION: { label: "Pending evaluation", className: "text-amber-700" },
};
const ATTEMPT_STATUS: Record<string, string> = { SUBMITTED: "Submitted", AUTO_SUBMITTED: "Submitted at the time limit", TERMINATED: "Terminated", IN_PROGRESS: "In progress" };

function formatTaken(seconds: number | null) {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${seconds % 60} s`;
}

/**
 * Marks for the written answers of one attempt. Objective questions are scored automatically and
 * shown read-only. The server validates every mark (0 … question maximum) and the finalize rules.
 */
export function EvaluationForm({ evaluation }: { evaluation: Evaluation }) {
  const router = useRouter();
  const toast = useToast();
  const { attempt, learner, assessment, result, questions } = evaluation;
  const toMark = questions.filter((q) => q.needsMarks);
  const [marks, setMarks] = useState<Record<string, Mark>>(() =>
    Object.fromEntries(toMark.map((q) => [q.assessmentQuestionId, { marks: q.awarded === null ? "" : String(q.awarded), comment: q.examinerComment ?? "" }])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const readOnly = !evaluation.canEdit;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = (id: string, patch: Partial<Mark>) => {
    setMarks((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
    setDirty(true);
  };
  const entered = toMark.filter((q) => marks[q.assessmentQuestionId]?.marks.trim() !== "");

  /** Map the service's field errors (marks.<i>.awardedMarks) back to questions. */
  function showErrors(payload: { assessmentQuestionId: string }[], fieldErrors?: Record<string, string[] | undefined>) {
    const e: Record<string, string> = {};
    for (const [key, msgs] of Object.entries(fieldErrors ?? {})) {
      const m = /^marks\.(\d+)\./.exec(key);
      if (m && payload[Number(m[1])]) e[payload[Number(m[1])].assessmentQuestionId] = msgs?.[0] ?? "Invalid";
    }
    setErrors(e);
  }

  async function save(): Promise<boolean> {
    const payload = entered.map((q) => ({ assessmentQuestionId: q.assessmentQuestionId, awardedMarks: marks[q.assessmentQuestionId].marks.trim(), comment: marks[q.assessmentQuestionId].comment }));
    if (payload.length === 0) return true;
    const r = await saveEvaluationAction(attempt.id, payload);
    if (!r.ok) {
      showErrors(payload, r.fieldErrors);
      toast.error("Marks not saved", r.error);
      return false;
    }
    setErrors({});
    setDirty(false);
    return true;
  }

  function onSave() {
    startTransition(async () => {
      if (await save()) {
        toast.success("Evaluation saved", `${entered.length} of ${toMark.length} answers marked.`);
        router.refresh();
      }
    });
  }

  function onFinalize() {
    startTransition(async () => {
      if (!(await save())) return;
      const r = await finalizeEvaluationAction(attempt.id);
      if (!r.ok) return toast.error("Can’t complete the evaluation yet", r.error);
      setDirty(false);
      toast.success("Evaluation completed", `${learner.name}: marks are final.`);
      router.push("/examiner/evaluations");
    });
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Evaluations", href: "/examiner/evaluations" }, { label: learner.name }]}
        title={learner.name}
        meta={<StatusBadge status={EVALUATION_LABEL[attempt.evaluationStatus]} />}
        description={`${assessment.name} · attempt #${attempt.attemptNumber} · submitted ${formatDateTime(iso(attempt.submittedAt))} IST`}
        actions={
          <>
            <DownloadReportButton href={`/api/reports/attempts/${attempt.id}/result`} label="Download Candidate Result" fallbackName="candidate-result.pdf" />
            <DownloadReportButton href={`/api/reports/attempts/${attempt.id}/evaluation`} label="Download Detailed Evaluation" fallbackName="evaluation-report.pdf" />
            {readOnly ? null : (
              <>
                <Button variant="outline" onClick={onSave} disabled={pending || !dirty}>
                  <Save /> Save Evaluation
                </Button>
                <Button onClick={() => setConfirm(true)} disabled={pending}>
                  <Send /> Complete Evaluation
                </Button>
              </>
            )}
          </>
        }
      />
      {readOnly ? (
        <p className="mb-5 flex items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4" /> Finalized {formatDateTime(iso(attempt.evaluationFinalizedAt))} IST
          {attempt.evaluationFinalizedBy ? ` by ${attempt.evaluationFinalizedBy.name}` : ""}. Marks are locked; an administrator can reopen the evaluation if they must change.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="grid content-start gap-4">
          {questions.map((q) => (
            <QuestionPanel key={q.assessmentQuestionId} q={q} mark={marks[q.assessmentQuestionId]} error={errors[q.assessmentQuestionId]} readOnly={readOnly} onChange={(patch) => set(q.assessmentQuestionId, patch)} />
          ))}
        </div>
        <aside className="grid content-start gap-4 lg:sticky lg:top-20 lg:self-start">
          <Panel title="Summary">
            <p className="text-2xl font-semibold tabular-nums">
              {result.obtained ?? result.provisional}{" "}
              <span className="text-base font-normal text-muted-foreground">/ {result.maxMarks}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {result.obtained !== null ? "Total" : "Saved total so far (unmarked answers count as 0)"} · objective {result.objectiveMarks} auto-scored{result.negativeMarks ? `, −${result.negativeMarks} negative` : ""}{dirty ? " · save to update" : ""}
            </p>
            {toMark.length ? (
              <>
                <Progress value={(entered.length / toMark.length) * 100} className="mt-3" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {entered.length} of {toMark.length} written answers marked
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No written answers to mark.</p>
            )}
          </Panel>
          <Panel title="Candidate">
            <DetailList
              className="grid-cols-[5.5rem_1fr]"
              items={[
                ["Learner", <span key="n" className="break-words">{learner.name}</span>],
                ["Email (login ID)", <span key="e" className="break-all">{learner.email}</span>],
                ["Attempt", `#${attempt.attemptNumber}`],
                ["Assessment", assessment.name],
                ["Batch", assessment.batch?.name ?? "—"],
                ["Status", ATTEMPT_STATUS[attempt.status] ?? attempt.status],
                ["Started", formatDateTime(iso(attempt.startedAt))],
                ["Submitted", formatDateTime(iso(attempt.submittedAt))],
                ["Duration", formatTaken(attempt.timeTakenSeconds)],
              ]}
            />
          </Panel>
          <Panel title="Questions" bodyClassName="p-2">
            <nav aria-label="Jump to question">
              <ul className="grid gap-0.5 text-sm">
                {questions.map((q) => {
                  const saved = q.awarded === null ? "" : String(q.awarded);
                  const unsaved = q.needsMarks && !!marks[q.assessmentQuestionId] && marks[q.assessmentQuestionId].marks.trim() !== saved;
                  return (
                    <li key={q.assessmentQuestionId}>
                      <a href={`#q-${q.assessmentQuestionId}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted">
                        <span className="font-medium">Q{q.number}</span>
                        <span className={cn("truncate text-xs", unsaved ? "text-amber-700" : STATUS[q.status].className)}>
                          {unsaved ? "Unsaved changes" : STATUS[q.status].label}
                          {q.awarded !== null ? ` · ${q.awarded}/${q.maxMarks}` : ""}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </Panel>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Complete this evaluation?"
        description="Every written answer needs marks. After completing, the marks are final and can only be changed if an administrator reopens the evaluation."
        confirmLabel="Complete Evaluation"
        onConfirm={onFinalize}
      />
    </>
  );
}

function QuestionPanel({ q, mark, error, readOnly, onChange }: { q: Question; mark?: Mark; error?: string; readOnly: boolean; onChange: (p: Partial<Mark>) => void }) {
  const objective = q.kind === "objective";
  return (
    <div id={`q-${q.assessmentQuestionId}`} className="scroll-mt-24">
      <Panel
        title={`Q${q.number}${q.section ? ` · ${q.section}` : ""}`}
        description={`${QUESTION_TYPES[q.type].label} · maximum ${q.maxMarks} mark${q.maxMarks === 1 ? "" : "s"}`}
        actions={
          <span className={cn("text-xs font-medium", STATUS[q.status].className)}>
            {STATUS[q.status].label} · {q.awarded === null ? "—" : q.awarded} / {q.maxMarks}
          </span>
        }
      >
        {q.context ? (
          <div className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <p className="font-medium">{q.context.text}</p>
            {q.context.passage ? <p className="mt-1 line-clamp-4 whitespace-pre-line text-muted-foreground">{q.context.passage}</p> : null}
          </div>
        ) : null}
        <p className="text-sm leading-relaxed whitespace-pre-line">{q.text}</p>
        {objective ? (
          <ul className="mt-3 grid gap-1.5 text-sm">
            {q.options.map((o, i) => {
              const chosen = q.answer.selectedOptionIds.includes(o.id);
              return (
                <li key={o.id} className={cn("flex items-center gap-2 rounded-md border px-3 py-1.5", o.isCorrect && "border-emerald-300 bg-emerald-50", chosen && !o.isCorrect && "border-red-300 bg-red-50")}>
                  <span className="w-4 font-medium text-muted-foreground">{String.fromCharCode(65 + i)}</span>
                  <span className="flex-1">{o.text}</span>
                  {chosen ? <span className="text-xs">Learner’s choice</span> : null}
                  {o.isCorrect ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Correct option" /> : chosen ? <XCircle className="size-4 text-red-600" aria-label="Wrong choice" /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <>
            <div className="mt-3 rounded-lg border bg-muted/40 px-4 py-3">
              <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Learner’s answer</p>
              <p className="text-sm leading-relaxed whitespace-pre-line">
                {q.answer.textAnswer?.trim() ? q.answer.textAnswer : q.answer.files.length ? <span className="text-muted-foreground italic">No written text — see the uploaded file.</span> : <span className="text-muted-foreground italic">Not answered — scores 0, nothing to mark.</span>}
              </p>
              {q.answer.files.length ? (
                <div className="mt-2 grid gap-1.5">
                  {q.answer.files.map((f) => (
                    <FileChip key={f.id} file={f} />
                  ))}
                </div>
              ) : null}
            </div>
            {q.guidance ? (
              <p className="mt-2 rounded-md border-l-2 border-primary bg-accent/40 px-3 py-2 text-xs">
                <span className="font-medium">Marking guidance:</span> {q.guidance}
              </p>
            ) : null}
            {q.needsMarks && mark ? (
              <div className="mt-4 grid gap-3 md:grid-cols-[9rem_1fr]">
                <div className="grid gap-1.5">
                  <label htmlFor={`m-${q.assessmentQuestionId}`} className="text-sm font-medium">
                    Marks
                  </label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      id={`m-${q.assessmentQuestionId}`}
                      type="number"
                      min={0}
                      max={q.maxMarks}
                      step={0.5}
                      value={mark.marks}
                      disabled={readOnly}
                      aria-invalid={!!error || undefined}
                      aria-label={`Marks for Q${q.number}`}
                      onChange={(e) => onChange({ marks: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground">/ {q.maxMarks}</span>
                  </div>
                  {error ? <p className="text-xs text-destructive">{error}</p> : null}
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor={`c-${q.assessmentQuestionId}`} className="text-sm font-medium">
                    Comments
                  </label>
                  <Textarea id={`c-${q.assessmentQuestionId}`} rows={2} value={mark.comment} disabled={readOnly} placeholder="Feedback for the learner (optional)" onChange={(e) => onChange({ comment: e.target.value })} />
                </div>
              </div>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
