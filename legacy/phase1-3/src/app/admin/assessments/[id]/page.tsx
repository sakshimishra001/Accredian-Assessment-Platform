import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "cn";
import { DifficultyLabel, QuestionTypeBadge, StatusBadge, VersionTag } from "@/components/admin/badges";
import { QuestionPreview } from "@/components/admin/question-preview";
import { ActionButton } from "@/components/shared/action-button";
import { EmptyState } from "@/components/shared/app-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { canEditSettings, STATUS_LABEL, STATUS_ORDER } from "@/lib/assessments/lifecycle";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { hasOptions } from "@/lib/questions/types";
import { ASSESSMENT_TYPE_LABEL, RESULT_VISIBILITY_LABEL } from "@/lib/validation/assessment";
import { requireRole } from "@/server/auth/guards";
import { getAssessment } from "@/server/services/assessments";
import {
  moveQuestionAction,
  refreshAssessmentQuestionAction,
  removeQuestionAction,
  transitionAssessmentAction,
  updateQuestionMarksAction,
} from "../actions";
import { QuestionMarksForm } from "./question-marks-form";

export const metadata: Metadata = { title: "Assessment" };

function Lifecycle({ status }: { status: (typeof STATUS_ORDER)[number] }) {
  const current = STATUS_ORDER.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 text-xs" aria-label="Lifecycle">
      {STATUS_ORDER.map((s, i) => (
        <li key={s} className="flex items-center gap-1">
          <span
            aria-current={i === current ? "step" : undefined}
            className={cn(
              "rounded-full px-2 py-0.5",
              i === current && "bg-primary font-medium text-primary-foreground",
              i < current && "text-foreground",
              i > current && "text-muted-foreground",
            )}
          >
            {STATUS_LABEL[s]}
          </span>
          {i < STATUS_ORDER.length - 1 ? <span className="text-muted-foreground">›</span> : null}
        </li>
      ))}
    </ol>
  );
}

export default async function AssessmentDetailPage({ params }: PageProps<"/admin/assessments/[id]">) {
  const actor = await requireRole("ADMIN");
  const { id } = await params;
  const a = await getAssessment(actor, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });

  const passingTooHigh = a.totals.questionCount > 0 && a.passingMarks > a.totals.totalMarks;

  return (
    <>
      <Link href="/admin/assessments" className="text-sm text-muted-foreground hover:underline">
        ← Assessments
      </Link>
      <div className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{a.name}</h1>
            <StatusBadge status={a.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {a.course.code} — {a.course.name} · {ASSESSMENT_TYPE_LABEL[a.type]}
          </p>
        </div>
        {canEditSettings(a.status) ? (
          <Link href={`/admin/assessments/${id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Pencil /> Edit settings
          </Link>
        ) : null}
      </div>

      <div className="mb-6">
        <Lifecycle status={a.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-6">
          <Card id="questions">
            <CardHeader>
              <CardTitle>Questions</CardTitle>
              <CardDescription>
                {a.totals.questionCount} question{a.totals.questionCount === 1 ? "" : "s"} ·{" "}
                <span className="font-medium text-foreground">{a.totals.totalMarks} total marks</span>
                {a.type === "MIXED" ? ` · ${a.totals.objectiveCount} objective, ${a.totals.subjectiveCount} subjective` : null}
              </CardDescription>
              <CardAction>
                {a.canEditQuestions ? (
                  <Link href={`/admin/assessments/${id}/questions`} className={buttonVariants({ size: "sm" })}>
                    <Plus /> Add questions
                  </Link>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="size-3.5" /> Locked
                  </span>
                )}
              </CardAction>
            </CardHeader>
            <CardContent>
              {!a.canEditQuestions ? (
                <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {a.status === "SCHEDULED"
                    ? "Questions are locked while scheduled. Move back to draft to change them."
                    : "Questions are locked because the assessment has gone live."}
                </p>
              ) : null}
              {a.questions.length === 0 ? (
                <EmptyState title="No questions yet" description="Add questions from the question bank." />
              ) : (
                <ol className="grid gap-3">
                  {a.questions.map((q, i) => (
                    <li key={q.id} className={cn("rounded-lg border p-3", (!q.compatible || (a.canEditQuestions && q.isArchived)) && "border-destructive/50")}>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">Q{q.position}</span>
                        <QuestionTypeBadge type={q.content.type} />
                        <DifficultyLabel difficulty={q.content.difficulty} />
                        <VersionTag version={q.snapshotVersion} />
                        {q.content.topic ? <span className="text-xs text-muted-foreground">{q.content.topic}</span> : null}
                        <span className="ml-auto text-sm tabular-nums">
                          {q.marks} mark{q.marks === 1 ? "" : "s"}
                          {q.negativeMarks > 0 ? <span className="text-destructive"> · −{q.negativeMarks}</span> : null}
                        </span>
                      </div>
                      {a.canEditQuestions && q.isArchived ? (
                        <p className="mb-2 text-xs text-destructive">This question is inactive in the bank. Remove it before scheduling.</p>
                      ) : null}
                      {q.hasNewerVersion ? (
                        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                          <span>
                            The bank has a newer version (v{q.latestVersion}). This assessment keeps its copy (v{q.snapshotVersion})
                            {a.canEditQuestions ? " unless you update it." : "."}
                          </span>
                          {a.canEditQuestions && !q.isArchived ? (
                            <ActionButton
                              action={refreshAssessmentQuestionAction.bind(null, id, q.id)}
                              size="xs"
                              confirm={`Replace with v${q.latestVersion}? Marks are kept.`}
                            >
                              <RefreshCw /> Use latest
                            </ActionButton>
                          ) : null}
                        </div>
                      ) : null}
                      {!q.compatible ? <p className="mb-2 text-xs text-destructive">Does not match the assessment type.</p> : null}
                      <details>
                        <summary className="cursor-pointer text-sm">
                          <span className="line-clamp-2 inline">{q.content.text}</span>
                        </summary>
                        <div className="mt-3">
                          <QuestionPreview type={q.content.type} text={q.content.text} options={q.content.options} guidance={q.content.guidance} compact />
                        </div>
                      </details>
                      {a.canEditQuestions ? (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                          <QuestionMarksForm
                            action={updateQuestionMarksAction.bind(null, id, q.id)}
                            marks={q.marks}
                            negativeMarks={q.negativeMarks}
                            allowNegative={hasOptions(q.content.type)}
                          />
                          <div className="flex items-start gap-1">
                            <ActionButton action={moveQuestionAction.bind(null, id, q.id, "up")} variant="ghost" size="icon-sm" disabled={i === 0} title="Move up">
                              <ArrowUp />
                            </ActionButton>
                            <ActionButton
                              action={moveQuestionAction.bind(null, id, q.id, "down")}
                              variant="ghost"
                              size="icon-sm"
                              disabled={i === a.questions.length - 1}
                              title="Move down"
                            >
                              <ArrowDown />
                            </ActionButton>
                            <ActionButton action={removeQuestionAction.bind(null, id, q.id)} variant="ghost" size="icon-sm" confirm="Remove?" title="Remove from assessment">
                              <Trash2 />
                            </ActionButton>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
              <CardDescription>
                Currently <span className="font-medium text-foreground">{STATUS_LABEL[a.status]}</span>.
                {a.status === "SCHEDULED" ? " Goes live automatically at the start time." : null}
                {a.status === "ACTIVE" ? " Ends automatically at the end time." : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {a.actions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No further actions.</p>
              ) : (
                a.actions.map((t) => (
                  <div key={t.to} className="grid gap-1.5">
                    <ActionButton
                      action={transitionAssessmentAction.bind(null, id, t.to)}
                      variant={t.to === "ARCHIVED" ? "destructive" : t.to === "DRAFT" || t.to === "EVALUATION" ? "outline" : "default"}
                      size="sm"
                      disabled={!t.check.ok}
                      confirm={t.description}
                    >
                      {t.label}
                    </ActionButton>
                    {!t.check.ok ? (
                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                        {t.check.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Start</dt>
                <dd>{formatDateTime(a.startAt)}</dd>
                <dt className="text-muted-foreground">End</dt>
                <dd>{formatDateTime(a.endAt)}</dd>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{a.durationMinutes} minutes</dd>
                <dt className="text-muted-foreground">Attempts</dt>
                <dd>{a.maxAttempts} per learner</dd>
                <dt className="text-muted-foreground">Passing</dt>
                <dd className={passingTooHigh ? "text-destructive" : undefined}>
                  {a.passingMarks} / {a.totals.totalMarks}
                </dd>
                <dt className="text-muted-foreground">Results</dt>
                <dd>{RESULT_VISIBILITY_LABEL[a.resultVisibility]}</dd>
                <dt className="text-muted-foreground">Proctoring</dt>
                <dd>{a.proctoringEnabled ? "Enabled" : "Disabled"}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>
                  {formatDateTime(a.createdAt)}
                  <div className="text-xs text-muted-foreground">by {a.createdBy.name}</div>
                </dd>
                {a.scheduledAt ? (
                  <>
                    <dt className="text-muted-foreground">Scheduled</dt>
                    <dd>{formatDateTime(a.scheduledAt)}</dd>
                  </>
                ) : null}
              </dl>
              {a.description ? (
                <div className="mt-4 border-t pt-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground uppercase">Instructions</div>
                  <p className="text-sm whitespace-pre-wrap">{a.description}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
