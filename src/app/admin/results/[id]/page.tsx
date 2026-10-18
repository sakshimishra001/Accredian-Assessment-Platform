import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MetricCard, PageHeader, Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { DownloadReportButton } from "@/components/reports/download-report-button";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { STATUS_LABEL } from "@/lib/assessments/lifecycle";
import { Role } from "@/lib/auth/rbac";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/prototype/lib/format";
import { requireRole } from "@/server/auth/guards";
import { getAssessment } from "@/server/services/assessments";
import { listAssessmentResults } from "@/server/services/results";
import { ResultActions } from "./result-actions";

export const metadata: Metadata = { title: "Assessment results" };

const RESULT_STATUS: Record<string, string> = { NOT_ATTEMPTED: "Not attempted", IN_PROGRESS: "In progress", EVALUATION_PENDING: "Pending evaluation", FINAL: "Final", TERMINATED: "Terminated" };
const EVALUATION: Record<string, string> = { PENDING: "Pending", IN_PROGRESS: "In progress", COMPLETED: "Completed" };
const RESULT_MOVES = ["ENDED", "EVALUATION", "RESULT_READY", "PUBLISHED"];

/** Every candidate's result for one assessment (admin). Scores come from the result service. */
export default async function AssessmentResultsPage({ params }: PageProps<"/admin/results/[id]">) {
  const actor = await requireRole(Role.ADMIN);
  const { id } = await params;
  const [results, assessment] = await Promise.all([listAssessmentResults(actor, id), getAssessment(actor, id)]).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const attempts = results.candidates.flatMap((c) => c.attempts);
  const submitted = attempts.filter((x) => x.status === "SUBMITTED" || x.status === "AUTO_SUBMITTED");
  const pendingEvaluation = submitted.filter((x) => x.evaluationStatus !== "COMPLETED").length;
  const finals = results.candidates.filter((c) => c.best);
  const passed = finals.filter((c) => c.best!.passed).length;
  const actions = assessment.actions
    .filter((t) => RESULT_MOVES.includes(t.to))
    .map((t) => ({ to: t.to, label: t.label, description: t.description, ok: t.check.ok, reasons: t.check.ok ? [] : t.check.reasons }));
  const published = results.assessment.publishedAt
    ? `published ${formatDateTime(results.assessment.publishedAt.toISOString())} IST`
    : results.assessment.resultVisibility === "IMMEDIATE"
      ? "shown to learners on submission"
      : "not published";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Results & Reports", href: "/admin/results" }, { label: results.assessment.name }]}
        title={results.assessment.name}
        meta={<StatusBadge status={STATUS_LABEL[results.assessment.status]} />}
        description={`${results.assessment.batch?.name ?? "No batch"} · results ${published}`}
        actions={
          <>
            <Link href={`/admin/assessments/${id}`} className={buttonVariants({ variant: "outline" })}>
              Assessment
            </Link>
            <Link href={`/admin/results/${id}/analytics`} className={buttonVariants({ variant: "outline" })}>
              Analytics
            </Link>
            <DownloadReportButton href={`/api/reports/assessments/${id}/results`} label="Download Results" fallbackName="assessment-results.csv" disabled={results.candidates.length === 0} />
            <ResultActions assessmentId={id} actions={actions} />
          </>
        }
      />
      {actions.some((m) => !m.ok) ? (
        <p className="mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">{[...new Set(actions.flatMap((m) => m.reasons))].join(" ")}</p>
      ) : null}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCard label="Candidates" value={results.candidates.length} />
        <MetricCard label="Submitted attempts" value={submitted.length} hint={`${attempts.length - submitted.length} in progress`} />
        <MetricCard label="Pending evaluation" value={pendingEvaluation} tone={pendingEvaluation ? "attention" : undefined} />
        <MetricCard label="Evaluation completed" value={submitted.length - pendingEvaluation} />
        <MetricCard label="Final results" value={finals.length} hint={finals.length ? `${passed} passed` : undefined} />
      </div>
      <Panel title="Candidates" bodyClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Learner</TableHead>
              <TableHead>Examiner</TableHead>
              <TableHead>Attempt</TableHead>
              <TableHead>Evaluation</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.candidates.map((c) => {
              const shown = c.attempts.find((x) => x.attemptId === c.best?.attemptId) ?? c.attempts.at(-1);
              const done = shown && (shown.status === "SUBMITTED" || shown.status === "AUTO_SUBMITTED");
              return (
                <TableRow key={c.candidateId}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{c.learner.name}</div>
                    <div className="text-xs text-muted-foreground">{c.learner.email}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.examiner?.name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {shown ? `#${shown.attemptNumber} · ${done ? `submitted ${formatDateTime(shown.submittedAt?.toISOString())}` : "in progress"}` : "—"}
                  </TableCell>
                  <TableCell>{done ? <StatusBadge status={EVALUATION[shown.evaluationStatus]} /> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {!done ? (
                      "—"
                    ) : shown.obtained !== null ? (
                      <>
                        {shown.obtained} / {shown.maxMarks}
                        <span className="block text-xs text-muted-foreground">{shown.percentage}%</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {shown.provisional} / {shown.maxMarks}
                        <span className="block text-xs">provisional</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.best ? (c.best.passed ? "Passed" : "Failed") : RESULT_STATUS[c.resultStatus]} />
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {done ? (
                      <Link href={`/admin/results/${id}/${shown.attemptId}`} className={buttonVariants({ size: "sm", variant: "outline" })} aria-label={`Result of ${c.learner.name}`}>
                        View
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
