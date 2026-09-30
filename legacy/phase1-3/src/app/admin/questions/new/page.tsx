import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireRole } from "@/server/auth/guards";
import { listCourseOptions } from "@/server/services/questions";
import { createQuestionAction } from "../actions";
import { QuestionForm } from "../question-form";

export const metadata: Metadata = { title: "New question" };

export default async function NewQuestionPage() {
  await requireRole("ADMIN");
  const courses = await listCourseOptions();
  return (
    <div className="max-w-3xl">
      <PageHeader title="New question" />
      <Card>
        <CardContent>
          <QuestionForm action={createQuestionAction} courses={courses} cancelHref="/admin/questions" submitLabel="Create question" />
        </CardContent>
      </Card>
    </div>
  );
}
