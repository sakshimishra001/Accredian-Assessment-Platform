import Link from "next/link";
import { Ban, CalendarClock, CheckCircle2, Clock, PlayCircle } from "lucide-react";
import { Panel } from "@/components/proto/page";
import { StatusBadge } from "@/components/proto/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { learnerAssessmentState as learnerState, type LearnerAssessmentState } from "@/lib/learner/landing";
import { formatDateTime, formatDuration } from "@/prototype/lib/format";
import type { MyAssessment as Overview } from "@/server/services/learner-home";

export { learnerState };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const LABEL: Record<LearnerAssessmentState, string> = { in_progress: "In progress", open: "Active", upcoming: "Scheduled", completed: "Completed", closed: "Closed" };

/** One of the learner's assigned assessments (server component). */
export function MyAssessmentCard({ overview: o }: { overview: Overview }) {
  const a = o.assessment;
  const state = learnerState(o);
  const last = o.attempts.at(-1);
  const questions = o.sections.reduce((n, s) => n + s.questionCount, 0);
  return (
    <Panel title={a.name} description={a.courseName} actions={<StatusBadge status={LABEL[state]} />}>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <ul className="grid gap-1.5 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <CalendarClock className="size-4" /> {formatDateTime(iso(a.startAt))} – {formatDateTime(iso(a.endAt))} IST
          </li>
          <li className="flex items-center gap-2">
            <Clock className="size-4" /> {formatDuration(a.durationMinutes)} · {questions} questions · {o.attempts.length} of {a.maxAttempts} attempt{a.maxAttempts === 1 ? "" : "s"} used
          </li>
          {last && last.status === "TERMINATED" ? (
            <li className="flex items-center gap-2 text-red-700">
              <Ban className="size-4" /> {last.terminatedByFocus ? "Terminated (proctoring violation limit reached)" : "Terminated by the administrator"}
            </li>
          ) : last && last.status !== "IN_PROGRESS" ? (
            <li className="flex items-center gap-2 text-emerald-700">
              <CheckCircle2 className="size-4" /> Submitted {formatDateTime(iso(last.submittedAt))} IST
            </li>
          ) : null}
        </ul>
        <div className="flex flex-wrap gap-2">
        {state === "completed" ? (
          <Link href="/learner/results" className={buttonVariants({ variant: "outline" })}>
            View results
          </Link>
        ) : null}
        {/* A full page load, not a client-side navigation: the exam page's own Permissions-Policy (camera)
            only applies to a document loaded from it. */}
        <a href={`/learner/assessment/${a.id}`} className={buttonVariants({ variant: state === "open" || state === "in_progress" ? "default" : "outline" })}>
          {state === "in_progress" ? (
            <>
              <PlayCircle /> Continue
            </>
          ) : state === "open" ? (
            <>
              <PlayCircle /> Start
            </>
          ) : (
            "View"
          )}
        </a>
        </div>
      </div>
    </Panel>
  );
}
