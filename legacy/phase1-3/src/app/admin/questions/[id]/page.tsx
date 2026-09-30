import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { DifficultyLabel, InactiveBadge, QuestionTypeBadge, StatusBadge, VersionTag } from "@/components/admin/badges";
import { QuestionPreview } from "@/components/admin/question-preview";
import { ActionButton } from "@/components/shared/action-button";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { hasOptions } from "@/lib/questions/types";
import { requireRole } from "@/server/auth/guards";
import { getQuestion } from "@/server/services/questions";
import { deleteQuestionAction, setQuestionArchivedAction } from "../actions";

export const metadata: Metadata = { title: "Question" };

export default async function QuestionDetailPage({ params }: PageProps<"/admin/questions/[id]">) {
  const actor = await requireRole("ADMIN");
  const { id } = await params;
  const question = await getQuestion(actor, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin/questions" className="text-sm text-muted-foreground hover:underline">
            ← Question bank
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Question</h1>
            <QuestionTypeBadge type={question.type} />
            <VersionTag version={question.version} />
            {question.isArchived ? <InactiveBadge /> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Link href={`/admin/questions/${id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Pencil /> Edit
          </Link>
          {question.isArchived ? (
            <ActionButton action={setQuestionArchivedAction.bind(null, id, false)}>
              <Power /> Activate
            </ActionButton>
          ) : (
            <ActionButton
              action={setQuestionArchivedAction.bind(null, id, true)}
              confirm="Inactive questions can't be added to assessments. Existing assessments keep them."
            >
              <PowerOff /> Deactivate
            </ActionButton>
          )}
          {question.usedIn.length === 0 ? (
            <ActionButton action={deleteQuestionAction.bind(null, id)} confirm="Delete permanently?" variant="destructive">
              <Trash2 /> Delete
            </ActionButton>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <QuestionPreview type={question.type} text={question.text} options={question.options} guidance={question.guidance} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{question.isArchived ? "Inactive" : "Active"}</dd>
                <dt className="text-muted-foreground">Version</dt>
                <dd>
                  v{question.version}
                  <div className="text-xs text-muted-foreground">Increases when the text, options or answer change.</div>
                </dd>
                <dt className="text-muted-foreground">Marks</dt>
                <dd className="tabular-nums">{question.marks}</dd>
                {hasOptions(question.type) ? (
                  <>
                    <dt className="text-muted-foreground">Negative marks</dt>
                    <dd className="tabular-nums">{question.negativeMarks}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Difficulty</dt>
                <dd><DifficultyLabel difficulty={question.difficulty} /></dd>
                <dt className="text-muted-foreground">Topic</dt>
                <dd>{question.topic ?? "—"}</dd>
                <dt className="text-muted-foreground">Course</dt>
                <dd>{question.course ? `${question.course.code} — ${question.course.name}` : "Any"}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>
                  {formatDateTime(question.createdAt)}
                  <div className="text-xs text-muted-foreground">by {question.createdBy.name}</div>
                </dd>
                <dt className="text-muted-foreground">Last updated</dt>
                <dd>
                  {formatDateTime(question.updatedAt)}
                  {question.updatedBy ? <div className="text-xs text-muted-foreground">by {question.updatedBy.name}</div> : null}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Used in</CardTitle>
            </CardHeader>
            <CardContent>
              {question.usedIn.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not used in any assessment yet, so it can be deleted.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {question.usedIn.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <Link href={`/admin/assessments/${a.id}`} className="block truncate hover:underline">
                          {a.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          uses v{a.questionVersion}
                          {a.questionVersion < question.version ? " (older copy)" : ""}
                        </span>
                      </span>
                      <StatusBadge status={a.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
