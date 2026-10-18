import { MetricCard, Panel } from "@/components/proto/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AssessmentAnalytics as Analytics } from "@/server/services/analytics";

const dash = "—";
const pct = (v: number | null) => (v === null ? dash : `${v}%`);
const num = (v: number | null) => (v === null ? dash : v);

function formatDuration(seconds: number | null) {
  if (seconds === null) return dash;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** Share of marks obtained, as a thin bar next to the number (the bar adds the at-a-glance comparison). */
function ShareBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">{dash}</span>;
  const width = Math.max(0, Math.min(100, value));
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
        <span className="block h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </span>
      <span className="w-14 text-right tabular-nums">{value}%</span>
    </span>
  );
}

/**
 * Assessment analytics (server component): aggregates only. Scores are final results — attempts
 * still awaiting evaluation are counted as pending and never scored or given pass / fail.
 */
export function AssessmentAnalyticsView({ data }: { data: Analytics }) {
  const { overview: o, attempts: a, assessment } = data;
  const max = assessment.maxMarks;
  const score = (v: number | null) => (v === null ? dash : `${v}${max !== null ? ` / ${max}` : ""}`);
  return (
    <div className="grid gap-6">
      {o.pendingEvaluation ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          Evaluation is pending for {o.pendingEvaluation} candidate{o.pendingEvaluation === 1 ? "" : "s"}. Scores, pass rate and question analysis below cover only the {o.evaluated} fully evaluated result
          {o.evaluated === 1 ? "" : "s"}.
        </p>
      ) : null}

      <section aria-label="Scores" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Average score" value={score(o.averageScore)} hint={o.averagePercentage !== null ? `${o.averagePercentage}% average` : "No final results yet"} />
        <MetricCard label="Highest score" value={score(o.highestScore)} />
        <MetricCard label="Lowest score" value={score(o.lowestScore)} />
        {assessment.passingMarks !== null ? (
          <MetricCard label="Pass rate" value={pct(o.passRate)} hint={o.evaluated ? `${o.passed} of ${o.evaluated} passed · pass mark ${assessment.passingMarks}` : `Pass mark ${assessment.passingMarks}`} />
        ) : (
          <MetricCard label="Pass rate" value={dash} hint="No passing marks set" />
        )}
      </section>

      <section aria-label="Participation" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Completion rate" value={pct(o.completionRate)} hint={`${o.submitted} of ${o.candidates} candidates submitted`} />
        <MetricCard label="Submitted attempts" value={a.submitted + a.autoSubmitted} hint={`${a.autoSubmitted} at the time limit · ${o.evaluated} evaluated · ${o.pendingEvaluation} pending`} />
        <MetricCard label="Terminated attempts" value={a.terminated} hint="Not submissions; not scored" tone={a.terminated ? "attention" : undefined} />
        <MetricCard label="Average duration" value={formatDuration(a.averageDurationSeconds)} hint="Submitted attempts, excluding pauses" />
      </section>

      <Panel title="Candidates and attempts">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-8">
          {(
            [
              ["Candidates", o.candidates],
              ["Started (attempts)", a.started],
              ["Candidates attempted", o.attempted],
              ["In progress", a.inProgress],
              ["Paused", a.paused],
              ["Locked", a.locked],
              ["Submitted", a.submitted],
              ["Auto-submitted", a.autoSubmitted],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="text-lg font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Question analysis" description={`Based on ${o.evaluated} final result${o.evaluated === 1 ? "" : "s"}. Correct / incorrect apply to auto-scored questions only.`} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Question</TableHead>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Max</TableHead>
                <TableHead className="text-right">Avg marks</TableHead>
                <TableHead className="text-right">Avg % of marks</TableHead>
                <TableHead className="text-right">Responses</TableHead>
                <TableHead className="text-right">Correct</TableHead>
                <TableHead className="text-right">Incorrect</TableHead>
                <TableHead className="pr-4 text-right">Unanswered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.questions.map((q) => (
                <TableRow key={q.assessmentQuestionId}>
                  <TableCell className="pl-4 font-medium">
                    Q{q.number}
                    <span className="block text-xs font-normal text-muted-foreground">{q.kind === "objective" ? "Auto-scored" : "Written"}</span>
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-muted-foreground">{q.section ?? dash}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.maxMarks}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.averageMarks)}</TableCell>
                  <TableCell className="text-right">
                    <ShareBar value={q.averagePercentage} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.responses}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.correct)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(q.incorrect)}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">{q.unanswered}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title="Batch performance" description="Candidates grouped by their batch in this course. A learner in two batches counts in both." bodyClassName="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Batch</TableHead>
                <TableHead className="text-right">Candidates</TableHead>
                <TableHead className="text-right">Attempted</TableHead>
                <TableHead className="text-right">Submitted</TableHead>
                <TableHead className="text-right">Avg score</TableHead>
                <TableHead className="text-right">Highest</TableHead>
                <TableHead className="text-right">Lowest</TableHead>
                {assessment.passingMarks !== null ? <TableHead className="text-right">Pass rate</TableHead> : null}
                <TableHead className="pr-4 text-right">Completion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.batches.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                    No candidates yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.batches.map((b) => (
                  <TableRow key={b.id ?? "none"}>
                    <TableCell className="pl-4 font-medium">{b.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.candidates}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.attempted}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.submitted}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(b.averageScore)}
                      {b.pendingEvaluation ? <span className="block text-xs text-muted-foreground">{b.pendingEvaluation} pending</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{num(b.highestScore)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(b.lowestScore)}</TableCell>
                    {assessment.passingMarks !== null ? <TableCell className="text-right tabular-nums">{pct(b.passRate)}</TableCell> : null}
                    <TableCell className="pr-4 text-right tabular-nums">{pct(b.completionRate)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
