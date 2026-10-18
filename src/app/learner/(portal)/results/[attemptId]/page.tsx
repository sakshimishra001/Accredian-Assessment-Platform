import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { cn } from "cn";
import { FileChip } from "@/components/files/file-preview";
import { DetailList, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { buttonVariants } from "@/components/ui/button";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { formatDate, formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getMyResult, type AnswerStatus } from "@/server/services/results";
import { PassBadge, ResultStateNote } from "../result-state";

export const metadata: Metadata = { title: "Result" };

const STATUS: Record<AnswerStatus, { label: string; className: string }> = {
  CORRECT: { label: "Correct", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  INCORRECT: { label: "Incorrect", className: "bg-red-50 text-red-700 ring-red-200" },
  PARTIALLY_CORRECT: { label: "Partially correct", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  UNANSWERED: { label: "Unanswered", className: "bg-muted text-muted-foreground ring-border" },
  EVALUATED: { label: "Evaluated", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  PENDING_EVALUATION: { label: "Pending evaluation", className: "bg-muted text-muted-foreground ring-border" },
};

const ATTEMPT_STATUS: Record<string, string> = { IN_PROGRESS: "In progress", SUBMITTED: "Submitted", AUTO_SUBMITTED: "Auto-submitted at the time limit", TERMINATED: "Terminated by the administrator" };

function formatTaken(seconds: number | null) {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h} h`, (h || m) && `${m} min`, `${s} s`].filter(Boolean).join(" ");
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Learner-provided or long text: kept as written (line breaks too) and wrapped inside the card. */
const longText = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

/**
 * One of the learner's own results. The service only returns the learner's own attempts at their
 * exam's assessment (anything else is a 404), computes every mark on the server and reveals marks
 * only when results are visible — and answers / feedback only as far as the result settings allow.
 */
export default async function MyResultPage({ params }: PageProps<"/learner/results/[attemptId]">) {
  const actor = await requireRole(Role.LEARNER);
  const { attemptId } = await params;
  const r = await getMyResult(actor, attemptId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const res = r.result;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "My Results", href: "/learner/results" }, { label: `Attempt #${r.attemptNumber}` }]}
        title={r.assessment.name}
        description={`Attempt #${r.attemptNumber}${r.submittedAt ? ` · submitted ${formatDateTime(r.submittedAt.toISOString())} IST` : ""}`}
        meta={res ? <PassBadge passed={res.passed} /> : null}
      />

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Panel title="Candidate">
          <DetailList
            items={[
              ["Name", <span key="n" className="break-words">{r.candidate.name}</span>],
              ["Email (login ID)", <span key="e" className="break-all">{r.candidate.email}</span>],
            ]}
          />
        </Panel>
        <Panel title="Assessment">
          <DetailList
            items={[
              ["Assessment", <span key="a" className="break-words">{r.assessment.name}</span>],
              ["Date", formatDate(r.assessment.startAt.toISOString())],
              ["Started", `${formatDateTime(r.startedAt.toISOString())} IST`],
              ["Submitted", r.submittedAt ? `${formatDateTime(r.submittedAt.toISOString())} IST` : r.terminatedAt ? `Ended ${formatDateTime(iso(r.terminatedAt))} IST` : "—"],
              ["Time taken", formatTaken(r.timeTakenSeconds)],
              ["Attempt status", ATTEMPT_STATUS[r.status] ?? r.status],
            ]}
          />
        </Panel>
      </div>

      {!res ? (
        <div className="grid max-w-xl gap-4">
          <ResultStateNote state={r.resultState} />
          <Link href="/learner" className={buttonVariants({ variant: "outline" })}>
            Back to dashboard
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Score" value={`${res.obtained} / ${res.maxMarks}`} />
            <MetricCard label="Percentage" value={`${res.percentage}%`} />
            <MetricCard label="Questions" value={res.questionCount} hint={`${res.answered} answered`} />
            {res.passed !== null ? <MetricCard label="Result" value={res.passed ? "Passed" : "Not passed"} hint={`Passing marks: ${res.passingMarks}`} /> : null}
          </div>
          <dl className="mb-6 flex flex-wrap gap-x-6 gap-y-2 rounded-lg border bg-background px-4 py-3 text-sm" aria-label="Answer summary">
            {(
              [
                ["Correct", res.correct],
                ["Incorrect", res.incorrect],
                ...(res.partiallyCorrect ? [["Partially correct", res.partiallyCorrect] as const] : []),
                ...(res.evaluated ? [["Evaluated", res.evaluated] as const] : []),
                ["Unanswered", res.unanswered],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex gap-1.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          {res.questions ? (
            <Panel title="Question-wise breakdown" bodyClassName="p-0">
              <ol className="divide-y">
                {res.questions.map((q, i) => {
                  const status = STATUS[q.status];
                  const showCase = q.caseText && q.caseText !== res.questions![i - 1]?.caseText;
                  const written = q.yourAnswer.textAnswer?.trim();
                  return (
                    <li key={q.number} className="grid gap-3 px-4 py-4 text-sm">
                      {showCase ? (
                        <div className="rounded-md border bg-muted/40 px-3 py-2">
                          <p className="mb-1 text-xs font-medium text-muted-foreground">Case study</p>
                          <p className={longText}>{q.caseText}</p>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-medium">Question {q.number}</span>
                          <span className="text-muted-foreground">
                            {q.section ? <> · <span className="break-words">{q.section}</span></> : null} · {QUESTION_TYPES[q.type].label}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", status.className)}>{status.label}</span>
                          <span className="tabular-nums">
                            {q.awarded === null ? "—" : q.awarded} / {q.maxMarks} marks
                          </span>
                        </div>
                      </div>
                      <p className={longText}>{q.text}</p>

                      {q.options.length ? (
                        <div className="grid gap-1">
                          <ul className="grid gap-1">
                            {q.options.map((o, oi) => {
                              const mine = q.yourAnswer.selectedOptionIds.includes(o.id);
                              const correct = !!q.correctOptionIds?.includes(o.id);
                              return (
                                <li key={o.id} className={cn("flex items-start gap-2 rounded-md border px-3 py-1.5", correct && "border-emerald-300 bg-emerald-50", mine && !correct && q.correctOptionIds && "border-red-300 bg-red-50")}>
                                  {mine ? <CircleDot className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
                                  <span className="w-4 font-medium text-muted-foreground">{String.fromCharCode(65 + oi)}</span>
                                  <span className={cn("min-w-0 flex-1", longText)}>{o.text}</span>
                                  <span className="flex shrink-0 flex-wrap justify-end gap-2 text-xs">
                                    {mine ? <span className="font-medium">Your answer</span> : null}
                                    {correct ? (
                                      <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                                        <CheckCircle2 className="size-3.5" aria-hidden /> Correct answer
                                      </span>
                                    ) : null}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                          {q.yourAnswer.selectedOptionIds.length === 0 ? <p className="text-xs text-muted-foreground">You didn’t select an answer.</p> : null}
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          <p className="text-xs font-medium text-muted-foreground">Your answer</p>
                          {written ? (
                            <p className={cn("max-h-96 overflow-y-auto rounded-md bg-muted/50 px-3 py-2", longText)}>{q.yourAnswer.textAnswer}</p>
                          ) : !q.yourAnswer.files.length ? (
                            <p className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground">Not answered</p>
                          ) : null}
                          {q.yourAnswer.files.map((f) => (
                            <FileChip key={f.id} file={f} className="py-1.5" />
                          ))}
                        </div>
                      )}

                      {"examinerComment" in q && q.examinerComment ? (
                        <div className="rounded-md border-l-2 border-primary/40 bg-muted/30 px-3 py-2">
                          <p className="mb-0.5 text-xs font-medium text-muted-foreground">Examiner feedback</p>
                          <p className={longText}>{q.examinerComment}</p>
                        </div>
                      ) : null}
                      {"explanation" in q && q.explanation ? (
                        <div className="rounded-md bg-muted/30 px-3 py-2">
                          <p className="mb-0.5 text-xs font-medium text-muted-foreground">Explanation</p>
                          <p className={longText}>{q.explanation}</p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </Panel>
          ) : (
            <p className="text-sm text-muted-foreground">Only your total score is shared for this assessment.</p>
          )}
        </>
      )}
    </>
  );
}
