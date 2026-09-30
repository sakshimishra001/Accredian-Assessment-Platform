import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/badges";
import { Card, CardContent } from "@/components/ui/card";
import { canEditSettings } from "@/lib/assessments/lifecycle";
import { toIstInput } from "@/lib/datetime";
import { NotFoundError } from "@/lib/errors";
import { requireRole } from "@/server/auth/guards";
import { getAssessment } from "@/server/services/assessments";
import { listCourseOptions } from "@/server/services/questions";
import { updateAssessmentAction } from "../../actions";
import { AssessmentForm } from "../../assessment-form";

export const metadata: Metadata = { title: "Assessment settings" };

export default async function EditAssessmentPage({ params }: PageProps<"/admin/assessments/[id]/edit">) {
  const actor = await requireRole("ADMIN");
  const { id } = await params;
  const [a, courses] = await Promise.all([
    getAssessment(actor, id).catch((e) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    listCourseOptions(),
  ]);
  if (!canEditSettings(a.status)) redirect(`/admin/assessments/${id}`);

  return (
    <div className="max-w-3xl">
      <Link href={`/admin/assessments/${id}`} className="text-sm text-muted-foreground hover:underline">
        ← {a.name}
      </Link>
      <div className="mt-2 mb-6 flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <StatusBadge status={a.status} />
      </div>
      {a.status !== "DRAFT" ? (
        <p className="mb-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {a.status === "ACTIVE"
            ? "The assessment is live. Only the end time can be extended."
            : "The assessment is scheduled. Questions and rules are frozen; move it back to draft to change them."}
        </p>
      ) : null}
      <Card>
        <CardContent>
          <AssessmentForm
            action={updateAssessmentAction.bind(null, id)}
            courses={courses}
            editable={a.editableFields}
            cancelHref={`/admin/assessments/${id}`}
            submitLabel="Save settings"
            totalMarks={a.totals.totalMarks}
            initial={{
              name: a.name,
              description: a.description,
              courseId: a.course.id,
              type: a.type,
              durationMinutes: a.durationMinutes,
              startAt: toIstInput(a.startAt),
              endAt: toIstInput(a.endAt),
              maxAttempts: a.maxAttempts,
              passingMarks: a.passingMarks,
              resultVisibility: a.resultVisibility,
              proctoringEnabled: a.proctoringEnabled,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
