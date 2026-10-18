import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileChip } from "@/components/files/file-preview";
import { DetailList, MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { DownloadReportButton } from "@/components/reports/download-report-button";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { PROCTORING_EVENT_LABEL } from "@/lib/proctoring/config";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { listAttemptProctoringEvents } from "@/server/services/proctoring";
import { getAttemptResult } from "@/server/services/results";
import { ReopenEvaluation } from "./reopen-evaluation";

export const metadata: Metadata = { title: "Attempt result" };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const OUTCOME: Record<string, string> = { correct: "Correct", incorrect: "Incorrect", unanswered: "Not answered", pending: "Awaiting marks", evaluated: "Marked" };
const EVALUATION: Record<string, string> = { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETED: "Completed" };
const SEVERITY: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
const ACTION: Record<string, string> = { WARNING: "Warning", LOCK: "Locked", TERMINATE: "Terminated" };

/** Question-by-question result of one attempt (admin, read-only apart from reopening the evaluation). */
export default async function AttemptResultPage({ params }: PageProps<"/admin/results/[id]/[attemptId]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id, attemptId } = await params;
  const r = await getAttemptResult(actor, attemptId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  if (r.assessment.id !== id) notFound();
  const events = await listAttemptProctoringEvents(actor, attemptId);
  const res = r.result;
  const terminated = r.attempt.status === "TERMINATED";
  const canReopen = r.attempt.evaluationStatus === "COMPLETED" && r.questions.some((q) => q.needsMarks) && ["ENDED", "EVALUATION", "ACTIVE", "PAUSED"].includes(r.assessment.status);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Results & Reports", href: "/admin/results" }, { label: r.assessment.name, href: `/admin/results/${id}` }, { label: r.learner.name }]}
        title={r.learner.name}
        meta={<StatusBadge status={EVALUATION[r.attempt.evaluationStatus]} />}
        description={`${r.assessment.name} · attempt #${r.attempt.attemptNumber} · ${terminated ? `terminated ${formatDateTime(iso(r.attempt.terminatedAt))}` : `submitted ${formatDateTime(iso(r.attempt.submittedAt))}`} IST`}
        actions={
          <>
            <DownloadReportButton href={`/api/reports/attempts/${attemptId}/result`} label="Download Candidate Result" fallbackName="candidate-result.pdf" />
            <DownloadReportButton href={`/api/reports/attempts/${attemptId}/evaluation`} label="Download Detailed Evaluation" fallbackName="evaluation-report.pdf" />
            {canReopen ? <ReopenEvaluation assessmentId={id} attemptId={attemptId} /> : null}
          </>
        }
      />
      {terminated ? (
        <p className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 ring-1 ring-red-200 ring-inset">
          This attempt was terminated by {r.attempt.terminatedBy?.name ?? "focus monitoring (violation limit reached)"} on {formatDateTime(iso(r.attempt.terminatedAt))} IST. It isn’t a submission and isn’t scored; the saved answers are shown below.
          {r.attempt.terminationReason ? ` Reason: ${r.attempt.terminationReason}` : ""}
        </p>
      ) : null}
      <div className={terminated ? "hidden" : "mb-6 grid grid-cols-2 gap-3 md:grid-cols-4"}>
        <MetricCard label="Score" value={res.obtained === null ? `${res.provisional} / ${res.maxMarks}` : `${res.obtained} / ${res.maxMarks}`} hint={res.obtained === null ? "provisional — evaluation pending" : `${res.percentage}%`} />
        <MetricCard label="Objective" value={res.objectiveMarks} hint={res.negativeMarks ? `−${res.negativeMarks} negative` : "auto-scored"} />
        <MetricCard label="Written" value={res.subjectiveMarks} hint={`${res.counts.evaluated} marked · ${res.counts.pending} pending`} />
        <MetricCard label="Answered" value={`${res.counts.answered} / ${res.counts.questions}`} hint={`${res.counts.correct} correct · ${res.counts.incorrect} incorrect`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel title="Questions" bodyClassName="p-0">
          <ul className="divide-y">
            {r.questions.map((q) => {
              const chosen = q.options.filter((o) => q.answer.selectedOptionIds.includes(o.id)).map((o) => String.fromCharCode(65 + q.options.indexOf(o)));
              const key = q.options.filter((o) => o.isCorrect).map((o) => String.fromCharCode(65 + q.options.indexOf(o)));
              return (
                <li key={q.assessmentQuestionId} className="grid gap-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      Q{q.number} <span className="font-normal text-muted-foreground">· {QUESTION_TYPES[q.type].label}{q.section ? ` · ${q.section}` : ""}</span>
                    </span>
                    <span className="tabular-nums">
                      {q.awarded === null ? "—" : q.awarded} / {q.maxMarks} · <span className="text-muted-foreground">{OUTCOME[q.outcome]}</span>
                    </span>
                  </div>
                  <p className="text-muted-foreground">{q.text}</p>
                  {q.kind === "objective" ? (
                    <p className="text-xs">
                      Answer: {chosen.length ? chosen.join(", ") : "—"} · Key: {key.join(", ")}
                    </p>
                  ) : (
                    <>
                      <p className="rounded-md bg-muted/50 px-3 py-2 text-xs whitespace-pre-line">{q.answer.textAnswer?.trim() || (q.answer.files.length ? "(file answer)" : "Not answered")}</p>
                      {q.answer.files.map((f) => (
                        <FileChip key={f.id} file={f} className="py-1.5" />
                      ))}
                      {q.examinerComment || q.evaluatedBy ? (
                        <p className="text-xs text-muted-foreground">
                          {q.evaluatedBy ? `Marked by ${q.evaluatedBy.name} ${formatDateTime(iso(q.evaluatedAt))}` : ""}
                          {q.examinerComment ? ` · “${q.examinerComment}”` : ""}
                        </p>
                      ) : null}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title="Details">
          <DetailList
            className="grid-cols-[6rem_1fr]"
            items={[
              ["Learner", r.learner.email],
              ["Batch", r.assessment.batch?.name ?? "—"],
              ["Started", formatDateTime(iso(r.attempt.startedAt))],
              ["Submitted", formatDateTime(iso(r.attempt.submittedAt))],
              ["Duration", r.attempt.timeTakenSeconds === null ? "—" : `${Math.floor(r.attempt.timeTakenSeconds / 60)} min ${r.attempt.timeTakenSeconds % 60} s (excluding pauses)`],
              ["Attempt", terminated ? (r.attempt.terminatedBy ? "Terminated by an administrator" : "Terminated by focus monitoring") : r.attempt.status === "AUTO_SUBMITTED" ? "Submitted at the deadline" : "Submitted"],
              [
                "Focus monitoring",
                r.focusMonitoring
                  ? `On · ${r.attempt.focusViolations} of ${r.focusMonitoring.maxViolations} violations · then ${r.focusMonitoring.action === "LOCK" ? "lock" : "terminate"}${
                      r.attempt.lockedAt ? ` · locked ${formatDateTime(iso(r.attempt.lockedAt))}` : terminated && !r.attempt.terminatedBy ? " · terminated at the limit" : ""
                    }`
                  : "Off",
              ],
              ["Finalized", r.attempt.evaluationFinalizedAt ? `${formatDateTime(iso(r.attempt.evaluationFinalizedAt))}${r.attempt.evaluationFinalizedBy ? ` by ${r.attempt.evaluationFinalizedBy.name}` : ""}` : "—"],
            ]}
          />
        </Panel>
      </div>
      {events.length ? (
        <Panel className="mt-6" title="Proctoring events" description="Recorded by the server (times are the server’s). Violations count towards one limit." bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 pl-4 font-medium">Time (IST)</th>
                  <th className="py-2 pr-3 font-medium">Event</th>
                  <th className="py-2 pr-3 font-medium">Severity</th>
                  <th className="py-2 pr-3 text-right font-medium">Violation</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-3 pl-4 whitespace-nowrap text-muted-foreground">{formatDateTime(iso(e.timestamp))}</td>
                    <td className="py-2 pr-3">{PROCTORING_EVENT_LABEL[e.eventType]}</td>
                    <td className="py-2 pr-3">{SEVERITY[e.severity]}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{e.violationNumber ?? "—"}</td>
                    <td className="py-2 pr-4">{e.actionTaken ? ACTION[e.actionTaken] : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
