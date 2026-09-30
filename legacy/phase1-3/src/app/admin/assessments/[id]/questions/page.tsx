import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState } from "@/components/shared/app-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { QuestionType } from "@/generated/prisma/enums";
import { canEditQuestions } from "@/lib/assessments/lifecycle";
import { NotFoundError } from "@/lib/errors";
import { QUESTION_TYPES } from "@/lib/questions/types";
import { ASSESSMENT_TYPE_LABEL } from "@/lib/validation/assessment";
import { requireRole } from "@/server/auth/guards";
import { listAddableQuestions } from "@/server/services/assessments";
import { listTopics } from "@/server/services/questions";
import { addQuestionsAction } from "../../actions";
import { QuestionPicker } from "./question-picker";

export const metadata: Metadata = { title: "Add questions" };

export default async function AddQuestionsPage({ params, searchParams }: PageProps<"/admin/assessments/[id]/questions">) {
  const actor = await requireRole("ADMIN");
  const { id } = await params;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const type = typeof sp.type === "string" ? (sp.type as QuestionType) : undefined;

  const topics = await listTopics(actor);
  const topic = topics.find((t) => t === sp.topic);
  const data = await listAddableQuestions(actor, id, { q, type, topic }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  if (!canEditQuestions(data.assessment.status)) redirect(`/admin/assessments/${id}`);

  return (
    <div className="max-w-4xl">
      <Link href={`/admin/assessments/${id}`} className="text-sm text-muted-foreground hover:underline">
        ← {data.assessment.name}
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Add questions</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Showing active questions that fit a {ASSESSMENT_TYPE_LABEL[data.assessment.type].toLowerCase()} assessment and are not
        already included. Inactive questions can&apos;t be added. Each added question is copied into this assessment, so later bank edits won&apos;t change it.
      </p>

      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search text or topic…" className="w-64" aria-label="Search" />
        <NativeSelect name="type" defaultValue={type ?? ""} aria-label="Question type">
          <NativeSelectOption value="">All allowed types</NativeSelectOption>
          {data.allowedTypes.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {QUESTION_TYPES[t].label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect name="topic" defaultValue={topic ?? ""} aria-label="Topic">
          <NativeSelectOption value="">All topics</NativeSelectOption>
          {topics.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {t}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <button type="submit" className={buttonVariants({ variant: "secondary" })}>
          Filter
        </button>
      </form>

      <Card>
        <CardContent>
          {data.rows.length === 0 ? (
            <EmptyState
              title="No questions available"
              description={q || type || topic ? "Try a different search." : "Create questions in the question bank first."}
            />
          ) : (
            <QuestionPicker rows={data.rows} action={addQuestionsAction.bind(null, id)} cancelHref={`/admin/assessments/${id}`} />
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Need a new one?{" "}
            <Link href="/admin/questions/new" className="underline">
              Create a question
            </Link>{" "}
            and come back.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
