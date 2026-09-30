import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shared/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getQuestion, listCourseOptions } from "@/server/services/questions";
import { updateQuestionAction } from "../../actions";
import { QuestionForm } from "../../question-form";

export const metadata: Metadata = { title: "Edit question" };

export default async function EditQuestionPage({ params }: PageProps<"/admin/questions/[id]/edit">) {
  const actor = await requireRole("ADMIN");
  const { id } = await params;
  const [question, courses] = await Promise.all([
    getQuestion(actor, id).catch((e) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    listCourseOptions(),
  ]);

  const uses = question.usedIn.length;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Edit question" />
      <Card>
        <CardContent>
          <QuestionForm
            action={updateQuestionAction.bind(null, id)}
            courses={courses}
            cancelHref={`/admin/questions/${id}`}
            submitLabel="Save changes"
            usageNote={
              uses
                ? `Used in ${uses} assessment(s). They keep their own copy (v${question.version}); saving creates v${question.version + 1} if the text, options or answer change. Draft assessments can opt in to the new version.`
                : undefined
            }
            initial={{
              type: question.type,
              text: question.text,
              guidance: question.guidance,
              marks: question.marks,
              negativeMarks: question.negativeMarks,
              topic: question.topic,
              difficulty: question.difficulty,
              courseId: question.courseId,
              options: question.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
