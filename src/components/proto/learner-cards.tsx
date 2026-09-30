"use client";

import Link from "next/link";
import { CalendarClock, Clock, FileText, PlayCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatDuration, formatTime } from "@/prototype/lib/format";
import { paperTotals } from "@/prototype/lib/paper";
import { useLookups, useProto } from "@/prototype/store";
import type { Assessment } from "@/prototype/types";
import { EmptyState } from "./page";
import { StatusBadge } from "./status-badge";

export function LearnerAssessmentCard({ a, kind }: { a: Assessment & { demo?: boolean }; kind: "active" | "upcoming" | "completed" }) {
  const lookup = useLookups();
  const s = useProto();
  const paper = lookup.paper(a.paperId);
  const marks = paper ? paperTotals(paper).marks : 0;
  const me = s.learners.find((l) => l.email === "learner@example.com");
  const result = s.results.find((r) => r.assessmentId === a.id && r.learnerId === me?.id);

  return (
    <div className="flex flex-col rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">{a.name}</p>
        {kind === "active" ? <StatusBadge status="Active" /> : kind === "upcoming" ? <StatusBadge status="Scheduled" /> : <StatusBadge status={result?.status ?? a.status} />}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{lookup.course(a.courseId)?.name}</p>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" /> Duration
          </dt>
          <dd className="font-medium">{formatDuration(a.durationMinutes)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileText className="size-3" /> Marks
          </dt>
          <dd className="font-medium tabular-nums">{marks}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarClock className="size-3" /> {kind === "completed" ? "Taken" : "Starts"}
          </dt>
          <dd className="font-medium">
            {kind === "active" && !a.demo ? "Now" : formatTime(a.schedule.start)}
            <span className="block text-xs font-normal text-muted-foreground">{formatDate(a.schedule.start)}</span>
          </dd>
        </div>
      </dl>
      {a.demo ? <p className="mt-3 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 ring-1 ring-amber-200 ring-inset">Prototype preview — opens early for demonstration.</p> : null}
      <div className="mt-4 border-t pt-3">
        {kind === "active" ? (
          <Link href={`/learner/assessment/${a.id}`} className={buttonVariants({ className: "w-full" })}>
            <PlayCircle /> Start Assessment
          </Link>
        ) : kind === "upcoming" ? (
          <Link href={`/learner/assessment/${a.id}`} className={buttonVariants({ variant: "outline", className: "w-full" })}>
            View instructions
          </Link>
        ) : result && result.score !== null ? (
          <p className="text-sm">
            Score <span className="font-semibold tabular-nums">{result.score}</span> / {result.max}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{result?.status === "Absent" ? "Not attempted" : "Results will be published after evaluation."}</p>
        )}
      </div>
    </div>
  );
}

export function LearnerSection({ title, items, kind, empty }: { title: string; items: (Assessment & { demo?: boolean })[]; kind: "active" | "upcoming" | "completed"; empty: string }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((a) => (
            <LearnerAssessmentCard key={a.id} a={a} kind={kind} />
          ))}
        </div>
      )}
    </section>
  );
}
