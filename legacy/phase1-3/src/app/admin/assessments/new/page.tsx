import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { ASSESSMENT_FIELDS } from "@/lib/assessments/lifecycle";
import { requireRole } from "@/server/auth/guards";
import { listCourseOptions } from "@/server/services/questions";
import { createAssessmentAction } from "../actions";
import { AssessmentForm } from "../assessment-form";

export const metadata: Metadata = { title: "New assessment" };

export default async function NewAssessmentPage() {
  await requireRole("ADMIN");
  const courses = await listCourseOptions();

  return (
    <div className="max-w-3xl">
      <PageHeader title="New assessment" description="It starts as a draft. Add questions, then schedule it." />
      <Card>
        <CardContent>
          <AssessmentForm
            action={createAssessmentAction}
            courses={courses}
            editable={ASSESSMENT_FIELDS}
            cancelHref="/admin/assessments"
            submitLabel="Create draft"
            initial={{
              name: "",
              description: null,
              courseId: courses.length === 1 ? courses[0].id : "",
              type: "OBJECTIVE",
              durationMinutes: 60,
              startAt: "",
              endAt: "",
              maxAttempts: 1,
              passingMarks: 0,
              resultVisibility: "ON_PUBLISH",
              proctoringEnabled: false,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
